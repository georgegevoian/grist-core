import { makeT } from "app/client/lib/localization";
import { getHomeUrl } from "app/client/models/AppModel";
import { Notifier } from "app/client/models/NotifyModel";
import { retryOnNetworkError } from "app/client/models/ToggleEnterpriseModel";
import { showEnterpriseToggle } from "app/client/ui/ActivationPage";
import {
  buildConfirmedRow,
  cssHappyText,
  cssSectionButtonRow,
  cssSectionContainer,
  cssSectionDescription,
} from "app/client/ui/AdminPanelCss";
import { ConfigSection, DraftChangeDescription } from "app/client/ui/DraftChanges";
import { cssValueLabel } from "app/client/ui/SettingsLayout";
import { ToggleEnterpriseWidget } from "app/client/ui/ToggleEnterpriseWidget";
import { bigBasicButton, bigPrimaryButton, primaryButton } from "app/client/ui2018/buttons";
import { labeledSquareCheckbox } from "app/client/ui2018/checkbox";
import { cssLink } from "app/client/ui2018/links";
import { loadingSpinner } from "app/client/ui2018/loaders";
import { cssModalBody, cssModalButtons, cssModalTitle, modal } from "app/client/ui2018/modals";
import { unstyledButton } from "app/client/ui2018/unstyled";
import { ConfigAPI } from "app/common/ConfigAPI";
import { commonUrls } from "app/common/gristUrls";
import { InstallAPIImpl } from "app/common/InstallAPI";
import { tokens } from "app/common/ThemePrefs";
import { getGristConfig } from "app/common/urlUtils";

import { Computed, Disposable, dom, DomContents, makeTestId, Observable, styled } from "grainjs";

const t = makeT("EditionSection");
const testId = makeTestId("test-edition-");

type Edition = "enterprise" | "core";

interface EditionSectionOptions {
  /** True when rendered in the admin panel; false / absent in the wizard. */
  inAdminPanel?: boolean;
  notifier?: Notifier;
  /**
   * Optional overrides for state that's normally derived from globals
   * (`showEnterpriseToggle()`, `getGristConfig().forceEnableEnterprise`, and
   * the toggle widget's initial value). Used by storybook so stories can
   * exercise each render state without launching a real server.
   */
  overrides?: {
    fullGristAvailable?: boolean;
    editionForced?: boolean;
    initialServerEdition?: Edition;
    supportsExternalFullEdition?: boolean;
  };
}

export class EditionSection extends Disposable implements ConfigSection {
  /**
   * Short description shown next to the item name in the admin panel
   * collapsed row. Exposed so stubs (e.g. the legacy "Enterprise" item)
   * can use the same wording without duplication.
   */
  public static description(): string {
    return t("Choose which edition of Grist to run on this server");
  }

  public canProceed: Computed<boolean>;
  public isDirty: Computed<boolean>;
  public describeChange: Computed<DraftChangeDescription[]>;

  public readonly fullGristAvailable: boolean;
  public readonly editionForced: boolean;
  public readonly needsRestart = true;

  // True on a grist-oss image that can download and run the external full edition at
  // runtime (see bootstrapFullEdition.ts). Only meaningful when !fullGristAvailable.
  private readonly _supportsExternalFullEdition: boolean;
  private readonly _installAPI = new InstallAPIImpl(getHomeUrl());

  private _selectedEdition = Observable.create<Edition | null>(this, null);
  private _serverEdition = Observable.create<Edition>(this, "core");
  // Pre-confirmed in admin-panel mode so the confirm/edit flow only runs in the wizard.
  private _editionConfirmed = Observable.create<boolean>(this, !!this._options.inAdminPanel);

  // Only created in admin-panel mode (requires a notifier).
  private _toggleEnterprise: ToggleEnterpriseWidget | null;
  private _configAPI = new ConfigAPI(getHomeUrl());

  constructor(private _options: EditionSectionOptions = {}) {
    super();

    const overrides = _options.overrides ?? {};
    this.fullGristAvailable = overrides.fullGristAvailable ?? showEnterpriseToggle();
    this.editionForced = overrides.editionForced ?? !!getGristConfig().forceEnableEnterprise;
    this._supportsExternalFullEdition =
      overrides.supportsExternalFullEdition ?? !!getGristConfig().supportsExternalFullEdition;

    const notifier = this._options.notifier;
    this._toggleEnterprise = notifier ?
      ToggleEnterpriseWidget.create(this, notifier) :
      null;

    this._serverEdition.set(
      overrides.initialServerEdition ??
      (this._canUseExternalFullEdition() ?
        // On the external-full-edition image, the running edition follows the relocated
        // worker's deployment type, not the activation toggle.
        (getGristConfig().deploymentType === "enterprise" ? "enterprise" : "core") :
        (this._toggleEnterprise?.getEnterpriseToggleObservable().get() ? "enterprise" : "core")),
    );

    // Start the selection at the server's current edition in admin-panel mode and on the
    // external-full-edition image, so the section isn't dirty before the user acts. In plain
    // wizard mode, default to Full Grist when available. Set here so a re-render can't reset it.
    this._selectedEdition.set(this._options.inAdminPanel || this._canUseExternalFullEdition() ?
      this._serverEdition.get() :
      this.fullGristAvailable ? "enterprise" : "core",
    );

    this.canProceed = Computed.create(this, use => use(this._editionConfirmed));
    this.isDirty = Computed.create(this, (use) => {
      if (!use(this._editionConfirmed)) { return false; }
      const selected = use(this._selectedEdition);
      if (selected === null) { return false; }
      return selected !== use(this._serverEdition);
    });
    this.describeChange = Computed.create(this, use => [{
      label: t("Edition"),
      value: use(this._selectedEdition) === "enterprise" ? t("Full Grist") : t("Community edition"),
    }]);
  }

  public buildStatusDisplay(): DomContents {
    if (this.editionForced) {
      return cssValueLabel(cssHappyText(t("On")));
    }
    if (!this.fullGristAvailable) {
      return cssValueLabel(t("community"));
    }
    const toggle = this._toggleEnterprise?.getEnterpriseToggleObservable();
    if (!toggle) {
      return cssValueLabel(t("community"));
    }
    return dom.domComputed(toggle, (isEnterprise) => {
      if (isEnterprise) {
        return cssValueLabel(cssHappyText(t("full")));
      }
      return cssValueLabel(t("community"));
    });
  }

  public buildDom(): DomContents {
    const toggle = this._toggleEnterprise;
    return cssSectionContainer(
      this._buildCore(),
      // Only show ToggleEnterpriseWidget when the server is actually running
      // Full Grist -- that's where its activation-key / trial / license UI does
      // useful work. In "core" mode its "Enable Full Grist" button duplicates the
      // selector above, so the `serverEdition === "enterprise"` guard keeps it hidden
      // there. Applies to the external-full-edition image too, once it's converted.
      !this.editionForced && toggle ?
        dom.maybe(use => use(this._serverEdition) === "enterprise", () =>
          toggle.buildEnterpriseSection(),
        ) :
        null,
      testId("section"),
    );
  }

  public buildWizardDom(): DomContents {
    return cssSectionContainer(
      this._buildCore(),
      // No confirmed row when edition is forced by env (nothing to edit).
      this.editionForced ? null : buildConfirmedRow(
        this._editionConfirmed,
        () => { this._editionConfirmed.set(false); },
        { testPrefix: "edition" },
      ),
      testId("wizard"),
    );
  }

  public getSelectedEdition(): Edition | null {
    return this._selectedEdition.get();
  }

  /** Undefined in wizard mode (no ToggleEnterpriseWidget). */
  public getEnterpriseToggleObservable() {
    return this._toggleEnterprise?.getEnterpriseToggleObservable();
  }

  /** Null on community builds (no `/api/activation/status` endpoint). */
  public getInstallationIdObservable() {
    return this._toggleEnterprise?.getInstallationIdObservable() ?? null;
  }

  public async apply() {
    if (!this.isDirty.get()) { return; }
    const selected = this._selectedEdition.get();
    if (!selected) { return; }
    if (this._canUseExternalFullEdition()) {
      // Persist the intent; the server downloads/removes the external copy and reforks on
      // the restart that DraftChangesManager fires next (which also picks up any other
      // pending change persisted before us).
      await retryOnNetworkError(() =>
        this._installAPI.updateInstallPrefs({ useExternalFullEdition: selected === "enterprise" }));
    } else {
      await this._configAPI.setValue({ edition: selected });
    }
    this._serverEdition.set(selected);
  }

  /**
   * How many readiness polls (~1s each) the restart after {@link apply} may need. Enabling
   * the external full edition downloads hundreds of MB before the server is ready; switching
   * back only reforks (and reclaims the copy). Undefined (default wait) for a baked-in
   * edition switch. Consulted by DraftChangesManager only for dirty sections, so it keys off
   * the target selection (which `apply` doesn't change until it succeeds).
   */
  public get restartWaitAttempts(): number | undefined {
    if (!this._canUseExternalFullEdition()) { return undefined; }
    return this._selectedEdition.get() === "enterprise" ?
      1200 :  // ~20 min
      120;    // ~2 min
  }

  /**
   * The staged external-full-edition switch, if any, so the apply call sites can show the
   * right loading modal while the (slow) restart runs. Read before apply, while still dirty.
   */
  public stagedExternalFullEditionSwitch(): "enable" | "disable" | null {
    if (!this._canUseExternalFullEdition() || !this.isDirty.get()) { return null; }
    return this._selectedEdition.get() === "enterprise" ? "enable" : "disable";
  }

  public async dismiss(): Promise<void> {
    if (!this.isDirty.get()) { return; }
    this._selectedEdition.set(this._serverEdition.get());
  }

  /**
   * Shared core: description, edition selector tabs, per-selection text.
   * Used by both admin panel and wizard.
   */
  private _buildCore(): DomContents {
    if (this.editionForced) {
      this._editionConfirmed.set(true);
      return cssSectionDescription(t("Full Grist is enabled via environment variable."));
    }

    // The selector drives both a baked-in full-capable image and a grist-oss image that can
    // download and run the external full edition. Only the truly can't-run-full case falls
    // through to the acknowledge-community core.
    if (!this.fullGristAvailable && !this._canUseExternalFullEdition()) {
      return this._buildUnavailableCore();
    }

    return this._buildSelector();
  }

  /**
   * Shared "Full Grist | Community edition" selector for both the baked-in full-capable
   * image and the external-full-edition (grist-oss) image. Picking an edition stages it via
   * `_editionConfirmed`; DraftChangesManager applies it (and restarts) on Apply/Continue.
   * The only external-edition specialization is the download warning and a confirmation
   * modal on the (heavy, restart-inducing) switch -- see the confirm block below.
   */
  private _buildSelector(): DomContents {
    const selectedEdition = this._selectedEdition;
    return [
      cssSectionDescription(
        t("Choose which edition of Grist to run on this server."),
      ),
      cssEditionButtons(
        cssEditionButton(
          t("Full Grist"),
          cssEditionButton.cls("-selected", use => use(selectedEdition) === "enterprise"),
          dom.on("click", () => { selectedEdition.set("enterprise"); this._editionConfirmed.set(false); }),
          testId("full-grist"),
        ),
        cssEditionButton(
          t("Community edition"),
          cssEditionButton.cls("-selected", use => use(selectedEdition) === "core"),
          dom.on("click", () => { selectedEdition.set("core"); this._editionConfirmed.set(false); }),
          testId("community"),
        ),
      ),
      dom.domComputed((use) => {
        const ed = use(selectedEdition);
        if (ed === "enterprise") {
          // Server already running Full Grist on the external-edition image: show the
          // activation-key / trial / license UI inline.
          if (this._canUseExternalFullEdition() && use(this._serverEdition) === "enterprise") {
            return this._toggleEnterprise?.buildEnterpriseSection() ?? null;
          }
          return [
            cssSectionDescription(
              t("The full Grist experience, with all features enabled for improved security, \
governance, and collaboration."),
            ),
            !this.editionForced && use(this._serverEdition) !== "enterprise" ? cssSectionDescription(
              t("You have 30 days to enter an activation key. Free activation keys are available \
to individuals and small orgs with less than US $1 million in total annual funding. \
{{learnMoreLink}} For larger orgs, see {{pricingLink}}.", {
                learnMoreLink: cssLink(
                  { href: commonUrls.helpEnterpriseOptIn, target: "_blank" },
                  t("Learn more."),
                ),
                pricingLink: cssLink({ href: commonUrls.plans, target: "_blank" }, t("pricing")),
              }),
            ) : null,
            // External-edition switch to Full Grist: warn about the download + restart.
            this._canUseExternalFullEdition() && use(this._serverEdition) === "core" ?
              cssSectionDescription(
                t("Switching downloads a complete copy of the full edition and restarts the \
server, which may be briefly unavailable."),
              ) : null,
          ];
        }
        return [
          cssSectionDescription(
            t("The free and open-source heart of Grist, with everything you need to open and edit \
Grist documents, control access, create forms, connect to single sign-on (SSO) \
providers, and much more."),
          ),
          // External-edition switch back to Community: warn about the restart.
          this._canUseExternalFullEdition() && use(this._serverEdition) === "enterprise" ?
            cssSectionDescription(
              t("Switching restarts the server, which may be briefly unavailable. The downloaded \
copy of the full edition stays on disk."),
            ) : null,
        ];
      }),
      dom.domComputed((use) => {
        if (use(this._editionConfirmed)) { return null; }
        const selected = use(selectedEdition);
        if (selected === null) { return null; }
        // On the external-edition image, an actual switch restarts the server (and downloads
        // when enabling), so gate staging behind a confirmation modal instead of the plain
        // inline confirm. A no-op selection (same as the running edition) still just confirms.
        if (this._canUseExternalFullEdition() && selected !== use(this._serverEdition)) {
          const enabling = selected === "enterprise";
          return cssSectionButtonRow(
            primaryButton(
              enabling ? t("Switch to full edition") : t("Switch to community edition"),
              dom.on("click", () => this._confirmExternalFullEditionSwitch(enabling)),
              testId(enabling ? "convert-full-edition" : "revert-full-edition"),
            ),
          );
        }
        return cssSectionButtonRow(
          primaryButton(
            t("Confirm edition"),
            dom.on("click", () => { this._editionConfirmed.set(true); }),
            testId("confirm"),
          ),
        );
      }),
    ];
  }

  /**
   * Confirm modal for the external-full-edition switch. Confirming only *stages* the change
   * (marks it confirmed so it becomes a draft change); the download/restart happens when the
   * draft batch is applied. Cancel / click-away just closes.
   */
  private _confirmExternalFullEditionSwitch(enabling: boolean): void {
    const title = enabling ? t("Switch to full edition") : t("Switch to community edition");
    const description = enabling ?
      t("This downloads a complete copy of the full edition and restarts the server, which \
may be briefly unavailable. The download can take a few minutes.") :
      t("This restarts the server, which may be briefly unavailable. The downloaded copy of \
the full edition stays on disk.");
    modal(ctl => [
      cssModalTitle(title),
      cssModalBody(cssSectionDescription(description)),
      cssModalButtons(
        bigPrimaryButton(
          t("Switch"),
          dom.on("click", () => { this._editionConfirmed.set(true); ctl.close(); }),
          testId("confirm-switch"),
        ),
        bigBasicButton(t("Cancel"), dom.on("click", () => ctl.close())),
      ),
    ]);
  }

  private _buildUnavailableCore(): DomContents {
    const selectedTab = Observable.create(this, "core");
    return [
      cssSectionDescription(
        t("Choose which edition of Grist to run on this server."),
      ),
      cssEditionButtons(
        cssEditionButton(
          t("Full Grist"),
          cssEditionButton.cls("-selected", use => use(selectedTab) === "enterprise"),
          dom.on("click", () => { selectedTab.set("enterprise"); this._editionConfirmed.set(false); }),
          testId("full-grist"),
        ),
        cssEditionButton(
          t("Community edition"),
          cssEditionButton.cls("-selected", use => use(selectedTab) === "core"),
          dom.on("click", () => { selectedTab.set("core"); this._editionConfirmed.set(false); }),
          testId("community"),
        ),
      ),
      dom.domComputed(selectedTab, (tab) => {
        if (tab === "enterprise") {
          return [
            cssSectionDescription(
              t("The full Grist experience, with all features enabled for improved security, \
governance, and collaboration."),
            ),
            // This installation can't run Full Grist, so point at the docs and have the
            // user acknowledge they're on Community.
            cssSectionDescription(
              t("Your installation does not bundle the Full Grist edition. \
Want Full Grist? {{enableLink}}", {
                enableLink: cssLink(
                  { href: commonUrls.helpEnterpriseOptIn, target: "_blank" },
                  t("See how to enable it."),
                ),
              }),
            ),
            dom.maybe(use => !use(this._editionConfirmed), () =>
              labeledSquareCheckbox(this._editionConfirmed,
                t("I understand I am running Grist Community edition"),
                testId("acknowledge"),
              ),
            ),
          ];
        }
        return [
          cssSectionDescription(
            t("The free and open-source heart of Grist, with everything you need to open and edit \
Grist documents, control access, create forms, connect to single sign-on (SSO) \
providers, and much more."),
          ),
          dom.maybe(use => !use(this._editionConfirmed), () => cssSectionButtonRow(
            primaryButton(
              t("Confirm edition"),
              dom.on("click", () => {
                this._editionConfirmed.set(true);
              }),
              testId("confirm"),
            ),
          )),
        ];
      }),
    ];
  }

  // True when this OSS server can download and run the external full edition, and has the
  // notifier the activation-key UI needs. Gates the selector's switch modal + download.
  private _canUseExternalFullEdition(): boolean {
    return this._supportsExternalFullEdition && Boolean(this._options.notifier);
  }
}

/**
 * Non-dismissible loading modal shown while the (slow) external-full-edition switch is
 * applied -- the server downloads a complete copy (when enabling) and reforks, so this can
 * take minutes. Stays up until `promise` settles, then rethrows so the caller can report
 * failures. No buttons: the download/restart can't be cancelled from here.
 */
export async function externalFullEditionSwitchModal<T>(
  kind: "enable" | "disable",
  promise: Promise<T>,
): Promise<T> {
  modal((ctl) => {
    const close = () => ctl.close();
    promise.then(close, close);
    return cssModalLoading(
      loadingSpinner(),
      cssModalLoadingText(kind === "enable" ?
        t("Downloading the full edition… Your server will restart automatically when \
complete. This may take a few minutes.") :
        t("Switching to the community edition… Your server will restart automatically.")),
      testId("switching"),
    );
  }, { noClickAway: true, noEscapeKey: true });
  return await promise;
}

const cssModalLoading = styled("div", `
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 8px 0;
  text-align: center;
`);

const cssModalLoadingText = styled("div", `
  color: ${tokens.secondary};
`);

const cssEditionButtons = styled("div", `
  background: ${tokens.bgTertiary};
  border-radius: 10px;
  display: flex;
  column-gap: 3px;
  margin-bottom: 16px;
  padding: 3px;
`);

const cssEditionButton = styled(unstyledButton, `
  border-radius: 7px;
  color: ${tokens.secondary};
  cursor: pointer;
  flex: 1;
  font-weight: 500;
  padding: 8px 6px;
  text-align: center;
  transition: color 0.2s, background 0.2s, box-shadow 0.2s;

  &:hover, &-selected {
    color: ${tokens.body};
  }

  &:focus-visible {
    outline: 3px solid ${tokens.primary};
    outline-offset: 2px;
  }

  &-selected {
    background: ${tokens.bg};
    box-shadow:
      0 1px 3px rgba(0, 0, 0, 0.15),
      0 1px 2px rgba(0, 0, 0, 0.1);
    font-weight: 600;
  }

  &-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`);
