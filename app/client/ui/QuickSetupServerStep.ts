import { makeT } from "app/client/lib/localization";
import { AppModel } from "app/client/models/AppModel";
import { BaseUrlSection } from "app/client/ui/BaseUrlSection";
import { DraftChangesManager } from "app/client/ui/DraftChanges";
import { EditionSection, externalFullEditionSwitchModal } from "app/client/ui/EditionSection";
import { ApplyResult, quickSetupContinueButton, QuickSetupSection } from "app/client/ui/QuickSetupContinueButton";
import { quickSetupStepHeader } from "app/client/ui/QuickSetupStepHeader";
import { cssQuickSetupCard } from "app/client/ui/SettingsLayout";

import { Computed, Disposable, dom, DomContents, makeTestId, Observable, styled, UseCBOwner } from "grainjs";

const t = makeT("QuickSetupServerStep");
const testId = makeTestId("test-quick-setup-");

/**
 * First step of QuickSetup: Base URL + Edition. Collects draft changes
 * across two sections and applies them in a single batch via the shared
 * QuickSetup continue button.
 *
 * Implements {@link QuickSetupSection} directly -- the step is itself
 * the unit the QuickSetup continue button drives, just composed of two
 * underlying sections via {@link DraftChangesManager}.
 */
export class QuickSetupServerStep extends Disposable implements QuickSetupSection {
  public canProceed: Computed<boolean>;
  public isDirty: Computed<boolean>;
  public isApplying: Observable<boolean>;

  private _baseUrl = BaseUrlSection.create(this);
  private _edition: EditionSection;
  private _drafts = DraftChangesManager.create(this);

  constructor(private _appModel: AppModel, private _onComplete: () => void) {
    super();
    // Pass the notifier so the runtime external-full-edition switch (download + restart) is
    // available in the wizard, mirroring the admin panel. It's a normal staged section here:
    // confirming stages it, and Continue applies the batch (persisting any base-URL change
    // first, then downloading + restarting) -- so switching no longer drops other pending
    // changes.
    this._edition = EditionSection.create(this, { notifier: this._appModel.notifier });
    this._drafts.addSection(this._baseUrl);
    this._drafts.addSection(this._edition);
    this.canProceed = Computed.create(this, use =>
      use(this._baseUrl.canProceed) && use(this._edition.canProceed),
    );
    this.isDirty = this._drafts.hasDraftChanges;
    this.isApplying = this._drafts.isApplying;
  }

  /** Pre-confirm message when the user hasn't yet confirmed URL/edition. */
  public customLabel(use: UseCBOwner): string | null {
    const urlOk = use(this._baseUrl.canProceed);
    const edOk = use(this._edition.canProceed);
    if (!urlOk && !edOk) { return t("Confirm base URL and edition to continue"); }
    if (!urlOk) { return t("Confirm base URL to continue"); }
    if (!edOk) { return t("Confirm edition to continue"); }
    return null;
  }

  public async apply(): Promise<ApplyResult> {
    // Read before applying -- applyAll() clears the section's dirty state. A staged
    // external-full-edition switch shows a download-aware modal over the (slow) restart.
    const editionSwitch = this._edition.stagedExternalFullEditionSwitch();
    const applying = this._drafts.applyAll();
    return editionSwitch ?
      externalFullEditionSwitchModal(editionSwitch, applying) :
      applying;
  }

  public buildDom(): DomContents {
    return dom("div",
      quickSetupStepHeader({
        icon: "Home",
        title: t("Server"),
        description: t("Set your server's base URL and choose which edition of Grist to run."),
      }),
      cssQuickSetupCard(
        cssStepSectionTitle(t("Base URL")),
        this._baseUrl.buildWizardDom(),
      ),
      cssQuickSetupCard(
        cssStepSectionTitle(t("Edition")),
        this._edition.buildWizardDom(),
      ),
      quickSetupContinueButton(this, () => this._onComplete(), testId("server-continue")),
    );
  }
}

const cssStepSectionTitle = styled("h3", `
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px 0;
`);
