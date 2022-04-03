/**
 * GristDoc manages an open Grist document on the client side.
 */
// tslint:disable:no-console

import {AccessRules} from 'app/client/aclui/AccessRules';
import {ActionLog} from 'app/client/components/ActionLog';
import * as BaseView from 'app/client/components/BaseView';
import {isNumericLike, isNumericOnly} from 'app/client/components/ChartView';
import * as CodeEditorPanel from 'app/client/components/CodeEditorPanel';
import * as commands from 'app/client/components/commands';
import {CursorPos} from 'app/client/components/Cursor';
import {CursorMonitor, ViewCursorPos} from "app/client/components/CursorMonitor";
import {DataTables} from 'app/client/components/DataTables';
import {DocComm, DocUserAction} from 'app/client/components/DocComm';
import * as DocConfigTab from 'app/client/components/DocConfigTab';
import {Drafts} from "app/client/components/Drafts";
import {EditorMonitor} from "app/client/components/EditorMonitor";
import * as GridView from 'app/client/components/GridView';
import {Importer} from 'app/client/components/Importer';
import {ActionGroupWithCursorPos, UndoStack} from 'app/client/components/UndoStack';
import {ViewLayout} from 'app/client/components/ViewLayout';
import {get as getBrowserGlobals} from 'app/client/lib/browserGlobals';
import {DocPluginManager} from 'app/client/lib/DocPluginManager';
import {ImportSourceElement} from 'app/client/lib/ImportSourceElement';
import {createSessionObs} from 'app/client/lib/sessionObs';
import {setTestState} from 'app/client/lib/testState';
import {selectFiles} from 'app/client/lib/uploads';
import {reportError} from 'app/client/models/AppModel';
import * as DataTableModel from 'app/client/models/DataTableModel';
import {DataTableModelWithDiff} from 'app/client/models/DataTableModelWithDiff';
import {DocData} from 'app/client/models/DocData';
import {DocInfoRec, DocModel, ViewRec, ViewSectionRec} from 'app/client/models/DocModel';
import {DocPageModel} from 'app/client/models/DocPageModel';
import {UserError} from 'app/client/models/errors';
import {urlState} from 'app/client/models/gristUrlState';
import {getFilterFunc, QuerySetManager} from 'app/client/models/QuerySet';
import {getUserOrgPrefObs, getUserOrgPrefsObs, markAsSeen} from 'app/client/models/UserPrefs';
import {App} from 'app/client/ui/App';
import {DocHistory} from 'app/client/ui/DocHistory';
import {startDocTour} from "app/client/ui/DocTour";
import {showDocSettingsModal} from 'app/client/ui/DocumentSettings';
import {isTourActive} from "app/client/ui/OnBoardingPopups";
import {IPageWidget, toPageWidget} from 'app/client/ui/PageWidgetPicker';
import {IPageWidgetLink, linkFromId, selectBy} from 'app/client/ui/selectBy';
import {startWelcomeTour} from 'app/client/ui/welcomeTour';
import {isNarrowScreen, mediaSmall, testId} from 'app/client/ui2018/cssVars';
import {IconName} from 'app/client/ui2018/IconList';
import {FieldEditor} from "app/client/widgets/FieldEditor";
import {MinimalActionGroup} from 'app/common/ActionGroup';
import {ClientQuery} from "app/common/ActiveDocAPI";
import {delay} from 'app/common/delay';
import {DisposableWithEvents} from 'app/common/DisposableWithEvents';
import {isSchemaAction, UserAction} from 'app/common/DocActions';
import {OpenLocalDocResult} from 'app/common/DocListAPI';
import {isList, isRefListType, RecalcWhen} from 'app/common/gristTypes';
import {HashLink, IDocPage, isViewDocPage, SpecialDocPage, ViewDocPage} from 'app/common/gristUrls';
import {undef, waitObs} from 'app/common/gutil';
import {LocalPlugin} from "app/common/plugin";
import {StringUnion} from 'app/common/StringUnion';
import {TableData} from 'app/common/TableData';
import {DocStateComparison} from 'app/common/UserAPI';
import {Computed, dom, Emitter, Holder, IDisposable, IDomComponent, Observable, styled, subscribe, toKo} from 'grainjs';
import * as ko from 'knockout';
import cloneDeepWith = require('lodash/cloneDeepWith');
import isEqual = require('lodash/isEqual');

const G = getBrowserGlobals('document', 'window');

// Re-export some tools to move them from main webpack bundle to the one with GristDoc.
export {DocComm, showDocSettingsModal, startDocTour};

export interface TabContent {
  showObs?: any;
  header?: boolean;
  label?: any;
  items?: any;
  buildDom?: any;
  keywords?: any;
}

export interface TabOptions {
  shortLabel?: string;
  hideSearchContent?: boolean;
  showObs?: any;
  category?: any;
}

const RightPanelTool = StringUnion("none", "docHistory", "validations");

export interface IExtraTool {
  icon: IconName;
  label: string;
  content: TabContent[]|IDomComponent;
}

export class GristDoc extends DisposableWithEvents {
  public docModel: DocModel;
  public viewModel: ViewRec;
  public activeViewId: Computed<IDocPage>;
  public currentPageName: Observable<string>;
  public docData: DocData;
  public docInfo: DocInfoRec;
  public docPluginManager: DocPluginManager;
  public querySetManager: QuerySetManager;
  public rightPanelTool: Observable<IExtraTool|null>;
  public isReadonly = this.docPageModel.isReadonly;
  public isReadonlyKo = toKo(ko, this.isReadonly);
  public comparison: DocStateComparison|null;
  // component for keeping track of latest cursor position
  public cursorMonitor: CursorMonitor;
  // component for keeping track of a cell that is being edited
  public editorMonitor: EditorMonitor;
  // component for keeping track of a cell that is being edited
  public draftMonitor: Drafts;
  // will document perform its own navigation (from anchor link)
  public hasCustomNav: Observable<boolean>;
  // Emitter triggered when the main doc area is resized.
  public readonly resizeEmitter = this.autoDispose(new Emitter());

  // This holds a single FieldEditor. When a new FieldEditor is created (on edit), it replaces the
  // previous one if any. The holder is maintained by GristDoc, so that we are guaranteed at
  // most one instance of FieldEditor at any time.
  public readonly fieldEditorHolder = Holder.create(this);
  // active field editor
  public readonly activeEditor: Observable<FieldEditor | null> = Observable.create(this, null);

  // Holds current view that is currently rendered
  public currentView: Observable<BaseView | null>;

  // Holds current cursor position with a view id
  public cursorPosition: Computed<ViewCursorPos | undefined>;

  public readonly userOrgPrefs = getUserOrgPrefsObs(this.docPageModel.appModel);

  // If the doc has a docTour. Used also to enable the UI button to restart the tour.
  public readonly hasDocTour: Computed<boolean>;

  private _actionLog: ActionLog;
  private _undoStack: UndoStack;
  private _lastOwnActionGroup: ActionGroupWithCursorPos|null = null;
  private _rightPanelTabs = new Map<string, TabContent[]>();
  private _docHistory: DocHistory;
  private _rightPanelTool = createSessionObs(this, "rightPanelTool", "none", RightPanelTool.guard);
  private _viewLayout: ViewLayout|null = null;
  private _showGristTour = getUserOrgPrefObs(this.userOrgPrefs, 'showGristTour');
  private _seenDocTours = getUserOrgPrefObs(this.userOrgPrefs, 'seenDocTours');

  constructor(
    public readonly app: App,
    public readonly docComm: DocComm,
    public readonly docPageModel: DocPageModel,
    openDocResponse: OpenLocalDocResult,
    plugins: LocalPlugin[],
    options: {
      comparison?: DocStateComparison  // initial comparison with another document
    } = {}
  ) {
    super();
    console.log("RECEIVED DOC RESPONSE", openDocResponse);
    this.docData = new DocData(this.docComm, openDocResponse.doc);
    this.docModel = new DocModel(this.docData);
    this.querySetManager = QuerySetManager.create(this, this.docModel, this.docComm);
    this.docPluginManager = new DocPluginManager(plugins,
      app.topAppModel.getUntrustedContentOrigin(), this.docComm, app.clientScope);

    // Maintain the MetaRowModel for the global document info, including docId and peers.
    this.docInfo = this.docModel.docInfoRow;

    this.hasDocTour = Computed.create(this, use =>
      use(this.docModel.allTableIds.getObservable()).includes('GristDocTour'));

    const defaultViewId = this.docInfo.newDefaultViewId;

    // Grainjs observable for current view id, which may be a string such as 'code'.
    this.activeViewId = Computed.create(this, (use) => {
      const {docPage} = use(urlState().state);

      // Return most special pages like 'code' and 'acl' as is
      if (typeof docPage === 'string' && docPage !== 'GristDocTour' && SpecialDocPage.guard(docPage)) {
        return docPage;
      }

      // GristDocTour is a special table that is usually hidden from users, but putting /p/GristDocTour
      // in the URL navigates to it and makes it visible in the list of pages in the sidebar
      // For GristDocTour, find the view with that name.
      // Otherwise find the view with the given row ID, because letting a non-existent row ID pass through here is bad.
      // If no such view exists, return the default view.
      const viewId = this.docModel.views.tableData.findRow(docPage === 'GristDocTour' ? 'name' : 'id', docPage);
      return viewId || use(defaultViewId);
    });

    // This viewModel reflects the currently active view, relying on the fact that
    // createFloatingRowModel() supports an observable rowId for its argument.
    // Although typings don't reflect it, createFloatingRowModel() accepts non-numeric values,
    // which yield an empty row, which is why we can cast activeViewId.
    this.viewModel = this.autoDispose(
      this.docModel.views.createFloatingRowModel(toKo(ko, this.activeViewId) as ko.Computed<number>));

    // Grainjs observable reflecting the name of the current document page.
    this.currentPageName = Computed.create(this, this.activeViewId,
      (use, docPage) => typeof docPage === 'number' ? use(this.viewModel.name) : docPage);

    // Whenever the active viewModel is deleted, switch to the default view.
    this.autoDispose(this.viewModel._isDeleted.subscribe((isDeleted) => {
      if (isDeleted) {
        // This should not be done synchronously, as that affects the same viewModel that triggered
        // this callback, and causes some obscure effects on knockout subscriptions.
        Promise.resolve().then(() => urlState().pushUrl({docPage: undefined})).catch(() => null);
      }
    }));

    // Navigate to an anchor if one is present in the url hash.
    this.autoDispose(subscribe(urlState().state, async (use, state) => {
      if (state.hash) {
        try {
          const cursorPos = this._getCursorPosFromHash(state.hash);
          await this.recursiveMoveToCursorPos(cursorPos, true);
        } catch (e) {
          reportError(e);
        } finally {
          setTimeout(finalizeAnchor, 0);
        }
      }
    }));

    // Start welcome tour if flag is present in the url hash.
    let tourStarting = false;
    this.autoDispose(subscribe(urlState().state, async (_use, state) => {
      // Onboarding tours were not designed with mobile support in mind. Disable until fixed.
      if (isNarrowScreen()) {
        return;
      }
      // If we have an active tour (or are in the process of starting one), don't start a new one.
      if (tourStarting || isTourActive()) {
        return;
      }
      const autoStartDocTour = this.hasDocTour.get() && !this._seenDocTours.get()?.includes(this.docId());
      const docTour = state.docTour || autoStartDocTour;
      const welcomeTour = state.welcomeTour || this._shouldAutoStartWelcomeTour();

      if (welcomeTour || docTour) {
        tourStarting = true;
        try {
          await this._waitForView();

          // Remove any tour-related hash-tags from the URL. So #repeat-welcome-tour and
          // #repeat-doc-tour are used as triggers, but will immediately disappear.
          await urlState().pushUrl({welcomeTour: false, docTour: false},
            {replace: true, avoidReload: true});

          if (!docTour) {
            startWelcomeTour(() => this._showGristTour.set(false));
          } else {
            const onFinishCB = () => (autoStartDocTour && markAsSeen(this._seenDocTours, this.docId()));
            await startDocTour(this.docData, this.docComm, onFinishCB);
          }
        } finally {
          tourStarting = false;
        }
      }
    }));

    // Importer takes a function for creating previews.
    const createPreview = (vs: ViewSectionRec) => GridView.create(this, vs, true);

    const importSourceElems = ImportSourceElement.fromArray(this.docPluginManager.pluginsList);
    const importMenuItems = [
      {
        label: 'Import from file',
        action: () => Importer.selectAndImport(this, importSourceElems, null, createPreview),
      },
      ...importSourceElems.map(importSourceElem => ({
        label: importSourceElem.importSource.label,
        action: () => Importer.selectAndImport(this, importSourceElems, importSourceElem, createPreview)
      }))
    ];

    // Set the available import sources in the DocPageModel.
    this.docPageModel.importSources = importMenuItems;

    this._actionLog = this.autoDispose(ActionLog.create({ gristDoc: this }));
    this._undoStack = this.autoDispose(UndoStack.create(openDocResponse.log, { gristDoc: this }));
    this._docHistory = DocHistory.create(this, this.docPageModel, this._actionLog);

    // Tap into docData's sendActions method to save the cursor position with every action, so that
    // undo/redo can jump to the right place.
    this.autoDispose(this.docData.sendActionsEmitter.addListener(this._onSendActionsStart, this));
    this.autoDispose(this.docData.sendActionsDoneEmitter.addListener(this._onSendActionsEnd, this));

    /* Command binding */
    this.autoDispose(commands.createGroup({
      undo() { this._undoStack.sendUndoAction().catch(reportError); },
      redo() { this._undoStack.sendRedoAction().catch(reportError); },
      reloadPlugins() { this.docComm.reloadPlugins().then(() => G.window.location.reload(false)); },
    }, this, true));

    this.listenTo(app.comm, 'docUserAction', this.onDocUserAction);

    this.autoDispose(DocConfigTab.create({gristDoc: this}));

    this.rightPanelTool = Computed.create(this, (use) => this._getToolContent(use(this._rightPanelTool)));

    this.comparison = options.comparison || null;

    // We need prevent default here to allow drop events to fire.
    this.autoDispose(dom.onElem(window, 'dragover', (ev) => ev.preventDefault()));
    // The default action is to open dragged files as a link, navigating out of the app.
    this.autoDispose(dom.onElem(window, 'drop', (ev) => ev.preventDefault()));

    // On window resize, trigger the resizeEmitter to update ViewLayout and individual BaseViews.
    this.autoDispose(dom.onElem(window, 'resize', () => this.resizeEmitter.emit()));

    // create current view observer
    this.currentView = Observable.create<BaseView | null>(this, null);

    // create computed observable for viewInstance - if it is loaded or not

    // Add an artificial intermediary computed only to delay the evaluation of currentView, so
    // that it happens after section.viewInstance is set. If it happens before, then
    // section.viewInstance is seen as null, and as it gets updated, GrainJS refuses to
    // recalculate this computed since it was already calculated in the same tick.
    const activeViewId = Computed.create(this, (use) => use(this.activeViewId));
    const viewInstance = Computed.create(this, (use) => {
      const section = use(this.viewModel.activeSection);
      const viewId = use(activeViewId);
      const view = use(section.viewInstance);
      return isViewDocPage(viewId) ? view : null;
    });
    // then listen if the view is present, because we still need to wait for it load properly
    this.autoDispose(viewInstance.addListener(async (view) => {
      if (view) {
        await view.getLoadingDonePromise();
      }
      // finally set the current view as fully loaded
      this.currentView.set(view);
    }));

    // create observable for current cursor position
    this.cursorPosition = Computed.create<ViewCursorPos | undefined>(this, use => {
      // get the BaseView
      const view = use(viewInstance);
      if (!view) { return undefined; }
      // get current viewId
      const viewId = use(this.activeViewId);
      if (!isViewDocPage(viewId)) { return undefined; }
      // read latest position
      const currentPosition = use(view.cursor.currentPosition);
      if (currentPosition) { return { ...currentPosition, viewId }; }
      return undefined;
    });

    this.hasCustomNav = Computed.create(this, urlState().state, (_, state) => {
      const hash = state.hash;
      return !!(hash && (undef(hash.colRef, hash.rowId, hash.sectionId) !== undefined));
    });

    this.draftMonitor = Drafts.create(this, this);
    this.cursorMonitor = CursorMonitor.create(this, this);
    this.editorMonitor = EditorMonitor.create(this, this);
  }

  /**
   * Returns current document's id
   */
  public docId() {
    return this.docPageModel.currentDocId.get()!;
  }

  public addOptionsTab(label: string, iconElem: any, contentObj: TabContent[], options: TabOptions): IDisposable {
    this._rightPanelTabs.set(label, contentObj);
    // Return a do-nothing disposable, to satisfy the previous interface.
    return {dispose: () => null};
  }

  /**
   * Builds the DOM for this GristDoc.
   */
  public buildDom() {
    return cssViewContentPane(testId('gristdoc'),
      cssViewContentPane.cls("-contents", use => use(this.activeViewId) === 'data'),
      dom.domComputed<IDocPage>(this.activeViewId, (viewId) => (
        viewId === 'code' ? dom.create((owner) => owner.autoDispose(CodeEditorPanel.create(this))) :
        viewId === 'acl' ? dom.create((owner) => owner.autoDispose(AccessRules.create(this, this))) :
        viewId === 'data' ? dom.create((owner) => owner.autoDispose(DataTables.create(this, this))) :
        viewId === 'GristDocTour' ? null :
        dom.create((owner) => (this._viewLayout = ViewLayout.create(owner, this, viewId)))
      )),
    );
  }

  // Open the given page. Note that links to pages should use <a> elements together with setLinkUrl().
  public openDocPage(viewId: IDocPage) {
    return urlState().pushUrl({docPage: viewId});
  }

  public showTool(tool: typeof RightPanelTool.type): void {
    this._rightPanelTool.set(tool);
  }

  /**
   * Returns an object representing the position of the cursor, including the section. It will have
   * fields { sectionId, rowId, fieldIndex }. Fields may be missing if no section is active.
   */
  public getCursorPos(): CursorPos {
    const pos = { sectionId: this.viewModel.activeSectionId() };
    const viewInstance = this.viewModel.activeSection.peek().viewInstance.peek();
    return Object.assign(pos, viewInstance ? viewInstance.cursor.getCursorPos() : {});
  }

  /**
   * Switch to the view/section and scroll to the record indicated by cursorPos. If cursorPos is
   * null, then moves to a position best suited for optActionGroup (not yet implemented).
   */
  public async moveToCursorPos(cursorPos?: CursorPos, optActionGroup?: MinimalActionGroup): Promise<void> {
    if (!cursorPos || cursorPos.sectionId == null) {
      // TODO We could come up with a suitable cursorPos here based on the action itself.
      // This should only come up if trying to undo/redo after reloading a page (since the cursorPos
      // associated with the action is only stored in memory of the current JS process).
      // A function like `getCursorPosForActionGroup(ag)` would also be useful to jump to the best
      // place from any action in the action log.
      return;
    }
    try {
      const viewInstance = await this._switchToSectionId(cursorPos.sectionId);
      if (viewInstance) {
        viewInstance.setCursorPos(cursorPos);
      }
    } catch(e) {
      reportError(e);
    }
  }

  /**
   * Process actions received from the server by forwarding them to `docData.receiveAction()` and
   * pushing them to actionLog.
   */
  public onDocUserAction(message: DocUserAction) {
    console.log("GristDoc.onDocUserAction", message);
    let schemaUpdated = false;
    /**
     * If an operation is applied successfully to a document, and then information about
     * it is broadcast to clients, and one of those broadcasts has a failure (due to
     * granular access control, which is client-specific), then that error is logged on
     * the server and also sent to the client via an `error` field.  Under normal operation,
     * there should be no such errors, but if they do arise it is best to make them as visible
     * as possible.
     */
    if (message.data.error) {
      reportError(new Error(message.data.error));
      return;
    }
    if (this.docComm.isActionFromThisDoc(message)) {
      const docActions = message.data.docActions;
      for (let i = 0, len = docActions.length; i < len; i++) {
        console.log("GristDoc applying #%d", i, docActions[i]);
        this.docData.receiveAction(docActions[i]);
        this.docPluginManager.receiveAction(docActions[i]);

        if (!schemaUpdated && isSchemaAction(docActions[i])) {
          schemaUpdated = true;
        }
      }
      // Add fromSelf property to actionGroup indicating if it's from the current session.
      const actionGroup = message.data.actionGroup;
      actionGroup.fromSelf = message.fromSelf || false;
      // Push to the actionLog and the undoStack.
      if (!actionGroup.internal) {
        this._actionLog.pushAction(actionGroup);
        this._undoStack.pushAction(actionGroup);
        if (actionGroup.fromSelf) {
          this._lastOwnActionGroup = actionGroup;
        }
      }
      if (schemaUpdated) {
        this.trigger('schemaUpdateAction', docActions);
      }
      if (typeof actionGroup.rowCount === "number") {
        this.docPageModel.rowCount.set(actionGroup.rowCount);
      }
    }
  }

  public getTableModel(tableId: string): DataTableModel {
    return this.docModel.dataTables[tableId];
  }

  // Get a DataTableModel, possibly wrapped to include diff data if a comparison is
  // in effect.
  public getTableModelMaybeWithDiff(tableId: string): DataTableModel {
    const tableModel = this.getTableModel(tableId);
    if (!this.comparison?.details) { return tableModel; }
    // TODO: cache wrapped models and share between views.
    return new DataTableModelWithDiff(tableModel, this.comparison.details);
  }

  /**
   * Sends an action to create a new empty table and switches to that table's primary view.
   */
  public async addEmptyTable(): Promise<void> {
    const tableInfo = await this.docData.sendAction(['AddEmptyTable']);
    await this.openDocPage(this.docModel.tables.getRowModel(tableInfo.id).primaryViewId());
  }

  /**
   * Adds a view section described by val to the current page.
   */
  public async addWidgetToPage(val: IPageWidget) {
    const docData = this.docModel.docData;
    const viewName = this.viewModel.name.peek();

    const res = await docData.bundleActions(
      `Added new linked section to view ${viewName}`,
      () => this.addWidgetToPageImpl(val)
    );

    // The newly-added section should be given focus.
    this.viewModel.activeSectionId(res.sectionRef);
  }

  /**
   * The actual implementation of addWidgetToPage
   */
  public async addWidgetToPageImpl(val: IPageWidget) {
    const viewRef = this.activeViewId.get();
    const tableRef = val.table === 'New Table' ? 0 : val.table;
    const link = linkFromId(val.link);

    const result = await this.docData.sendAction(
      ['CreateViewSection', tableRef, viewRef, val.type, val.summarize ? val.columns : null]
    );
    if (val.type === 'chart') {
      await this._ensureOneNumericSeries(result.sectionRef);
    }
    await this.docData.sendAction(
      ['UpdateRecord', '_grist_Views_section', result.sectionRef, {
        linkSrcSectionRef: link.srcSectionRef,
        linkSrcColRef: link.srcColRef,
        linkTargetColRef: link.targetColRef
      }]
    );
    return result;
  }

  /**
   * Adds a new page (aka: view) with a single view section (aka: page widget) described by `val`.
   */
  public async addNewPage(val: IPageWidget) {
    if (val.table === 'New Table') {
      const result = await this.docData.sendAction(['AddEmptyTable']);
      await this.openDocPage(result.views[0].id);
    } else {
      let result: any;
      await this.docData.bundleActions(`Add new page`, async () => {
        result = await this.docData.sendAction(
          ['CreateViewSection', val.table, 0, val.type, val.summarize ? val.columns : null]
        );
        if (val.type === 'chart') {
          await this._ensureOneNumericSeries(result.sectionRef);
        }
      });
      await this.openDocPage(result.viewRef);
      // The newly-added section should be given focus.
      this.viewModel.activeSectionId(result.sectionRef);
    }
  }

  /**
   * Opens a dialog to upload one or multiple files as tables and then switches to the first table's
   * primary view.
   */
  public async uploadNewTable(): Promise<void> {
    const uploadResult = await selectFiles({docWorkerUrl: this.docComm.docWorkerUrl,
                                            multiple: true});
    if (uploadResult) {
      const dataSource = {uploadId: uploadResult.uploadId, transforms: []};
      const importResult = await this.docComm.finishImportFiles(dataSource, [], {});
      const tableId = importResult.tables[0].hiddenTableId;
      const tableRowModel = this.docModel.dataTables[tableId].tableMetaRow;
      await this.openDocPage(tableRowModel.primaryViewId());
    }
  }

  public async saveViewSection(section: ViewSectionRec, newVal: IPageWidget) {
    const docData = this.docModel.docData;
    const oldVal: IPageWidget = toPageWidget(section);
    const viewModel = section.view();

    if (isEqual(oldVal, newVal)) {
      // nothing to be done
      return;
    }

    await this._viewLayout!.freezeUntil(docData.bundleActions(
      `Saved linked section ${section.title()} in view ${viewModel.name()}`,
      async () => {

        // if table changes or a table is made a summary table, let's replace the view section by a
        // new one, and return.
        if (oldVal.table !== newVal.table || oldVal.summarize !== newVal.summarize) {
          await this._replaceViewSection(section, newVal);
          return;
        }

        // if type changes, let's save it.
        if (oldVal.type !== newVal.type) {
          await section.parentKey.saveOnly(newVal.type);
        }

        // if grouped by column changes, let's use the specific user action.
        if (!isEqual(oldVal.columns, newVal.columns)) {
          await docData.sendAction(
            ['UpdateSummaryViewSection', section.getRowId(), newVal.columns]
          );
        }

        // update link
        if (oldVal.link !== newVal.link) {
          await this.saveLink(linkFromId(newVal.link));
        }
      }
    ));
  }

  // Save link for the active section.
  public async saveLink(link: IPageWidgetLink) {
    const viewModel = this.viewModel;
    return this.docData.sendAction(
      ['UpdateRecord', '_grist_Views_section', viewModel.activeSection.peek().getRowId(), {
        linkSrcSectionRef: link.srcSectionRef,
        linkSrcColRef: link.srcColRef,
        linkTargetColRef: link.targetColRef
      }]
    );
  }


  // Returns the list of all the valid links to link from one of the sections in the active view to
  // the page widget 'widget'.
  public selectBy(widget: IPageWidget) {
    const viewSections = this.viewModel.viewSections.peek().peek();
    return selectBy(this.docModel, viewSections, widget);
  }

  // Fork the document if it is in prefork mode.
  public async forkIfNeeded() {
    if (this.docPageModel.isPrefork.get()) {
      await this.docComm.forkAndUpdateUrl();
    }
  }

  // Turn the given columns into empty columns, losing any data stored in them.
  public async clearColumns(colRefs: number[]): Promise<void> {
    await this.docModel.columns.sendTableAction(
      ['BulkUpdateRecord', colRefs, {
        isFormula: colRefs.map(f => true),
        formula: colRefs.map(f => ''),
        // Set recalc settings to defaults when emptying a column.
        recalcWhen: colRefs.map(f => RecalcWhen.DEFAULT),
        recalcDeps: colRefs.map(f => null),
      }]
    );
  }

  // Convert the given columns to data, saving the calculated values and unsetting the formulas.
  public async convertIsFormula(colRefs: number[], opts: {toFormula: boolean, noRecalc?: boolean}): Promise<void> {
    return this.docModel.columns.sendTableAction(
      ['BulkUpdateRecord', colRefs, {
        isFormula: colRefs.map(f => opts.toFormula),
        recalcWhen: colRefs.map(f => opts.noRecalc ? RecalcWhen.NEVER : RecalcWhen.DEFAULT),
        recalcDeps: colRefs.map(f => null),
      }]
    );
  }

  // Updates formula for a column.
  public async updateFormula(colRef: number, formula: string): Promise<void> {
    return this.docModel.columns.sendTableAction(
      ['UpdateRecord', colRef, {
        formula,
      }]
    );
  }

  // Convert column to pure formula column.
  public async convertToFormula(colRef: number, formula: string): Promise<void> {
    return this.docModel.columns.sendTableAction(
      ['UpdateRecord', colRef, {
        isFormula: true,
        formula,
        recalcWhen: RecalcWhen.DEFAULT,
        recalcDeps: null,
      }]
    );
  }

  // Convert column to data column with a trigger formula
  public async convertToTrigger(colRefs: number, formula: string): Promise<void> {
    return this.docModel.columns.sendTableAction(
      ['UpdateRecord', colRefs, {
        isFormula: false,
        formula,
        recalcWhen: RecalcWhen.DEFAULT,
        recalcDeps: null,
      }]
    );
  }

  public getCsvLink() {
    const filters = this.viewModel.activeSection.peek().activeFilters.get().map(filterInfo => ({
      colRef : filterInfo.fieldOrColumn.origCol().origColRef(),
      filter : filterInfo.filter()
    }));

    const params = {
      viewSection: this.viewModel.activeSectionId(),
      tableId: this.viewModel.activeSection().table().tableId(),
      activeSortSpec: JSON.stringify(this.viewModel.activeSection().activeSortSpec()),
      filters : JSON.stringify(filters),
    };

    return this.docPageModel.appModel.api.getDocAPI(this.docId()).getDownloadCsvUrl(params);
  }

  public hasGranularAccessRules(): boolean {
    const rulesTable = this.docData.getMetaTable('_grist_ACLRules');
    // To check if there are rules, ignore the default no-op rule created for an older incarnation
    // of ACLs. It exists in older documents, and is still created for new ones. We detect it by
    // the use of the deprecated 'permissions' field, and not the new 'permissionsText' field.
    return rulesTable.numRecords() > rulesTable.filterRowIds({permissionsText: '', permissions: 63}).length;
  }

  /**
   * Move to the desired cursor position.  If colRef is supplied, the cursor will be
   * moved to a field with that colRef.  Any linked sections that need their cursors
   * moved in order to achieve the desired outcome are handled recursively.
   * If setAsActiveSection is true, the section in cursorPos is set as the current
   * active section.
   */
  public async recursiveMoveToCursorPos(
    cursorPos: CursorPos,
    setAsActiveSection: boolean,
    silent: boolean = false): Promise<void> {
    try {
      if (!cursorPos.sectionId) { throw new Error('sectionId required'); }
      if (!cursorPos.rowId) { throw new Error('rowId required'); }
      const section = this.docModel.viewSections.getRowModel(cursorPos.sectionId);
      const srcSection = section.linkSrcSection.peek();
      if (srcSection.id.peek()) {
        // We're in a linked section, so we need to recurse to make sure the row we want
        // will be visible.
        const linkTargetCol = section.linkTargetCol.peek();
        let controller: any;
        if (linkTargetCol.colId.peek()) {
          const destTable = await this._getTableData(section);
          controller = destTable.getValue(cursorPos.rowId, linkTargetCol.colId.peek());
        } else {
          controller = cursorPos.rowId;
        }
        const colId = section.linkSrcCol.peek().colId.peek();
        let srcRowId: any;
        const isSrcSummary = srcSection.table.peek().summarySource.peek().id.peek();
        if (!colId && !isSrcSummary) {
          // Simple case - source linked by rowId, not a summary.
          if (isList(controller)) {
            // Should be a reference list. Pick the first reference.
            controller = controller[1];  // [0] is the L type code, [1] is the first value
          }
          srcRowId = controller;
        } else {
          const srcTable = await this._getTableData(srcSection);
          const query: ClientQuery = {tableId: srcTable.tableId, filters: {}, operations: {}};
          if (colId) {
            query.operations[colId] = isRefListType(section.linkSrcCol.peek().type.peek()) ? 'intersects' : 'in';
            query.filters[colId] = isList(controller) ? controller.slice(1) : [controller];
          } else {
            // must be a summary -- otherwise dealt with earlier.
            const destTable = await this._getTableData(section);
            for (const srcCol of srcSection.table.peek().groupByColumns.peek()) {
              const filterColId = srcCol.summarySource.peek().colId.peek();
              controller = destTable.getValue(cursorPos.rowId, filterColId);
              query.operations[filterColId] = 'in';
              query.filters[filterColId] = isList(controller) ? controller.slice(1) : [controller];
            }
          }
          srcRowId = srcTable.getRowIds().find(getFilterFunc(this.docData, query));
        }
        if (!srcRowId || typeof srcRowId !== 'number') { throw new Error('cannot trace rowId'); }
        await this.recursiveMoveToCursorPos({
          rowId: srcRowId,
          sectionId: srcSection.id.peek(),
        }, false, silent);
      }
      const view: ViewRec = section.view.peek();
      const docPage: ViewDocPage = section.isRaw.peek() ? "data" : view.getRowId();
      if (docPage != this.activeViewId.get()) { await this.openDocPage(docPage); }
      if (setAsActiveSection) { view.activeSectionId(cursorPos.sectionId); }
      const fieldIndex = cursorPos.fieldIndex;
      const viewInstance = await waitObs(section.viewInstance);
      if (!viewInstance) { throw new Error('view not found'); }
      // Give any synchronous initial cursor setting a chance to happen.
      await delay(0);
      viewInstance.setCursorPos({ ...cursorPos, fieldIndex });
      // TODO: column selection not working on card/detail view, or getting overridden -
      // look into it (not a high priority for now since feature not easily discoverable
      // in this view).

      // even though the cursor is at right place, the scroll could not have yet happened
      // wait for a bit (scroll is done in a setTimeout 0)
      await delay(0);
    } catch (e) {
      console.debug(`_recursiveMoveToCursorPos(${JSON.stringify(cursorPos)}): ${e}`);
      if (!silent) {
        throw new UserError('There was a problem finding the desired cell.');
      }
    }
  }

  /**
   * Opens up an editor at cursor position
   * @param input Optional. Cell's initial value
   */
  public async activateEditorAtCursor(options: { init?: string, state?: any}) {
    const view = await this._waitForView();
    view?.activateEditorAtCursor(options);
  }

  /**
   * Waits for a view to be ready
   */
  private async _waitForView() {
    // For pages like ACL's, there isn't a view instance to wait for.
    if (!this.viewModel.activeSection.peek().getRowId()) {
      return null;
    }
    const view = await waitObs(this.viewModel.activeSection.peek().viewInstance);
    if (!view) {
      return null;
    }
    await view.getLoadingDonePromise();
    // Wait extra bit for scroll to happen.
    await delay(0);
    return view;
  }

  private _getToolContent(tool: typeof RightPanelTool.type): IExtraTool | null {
    switch (tool) {
      case 'docHistory': {
        return {icon: 'Log', label: 'Document History', content: this._docHistory};
      }
      case 'validations': {
        const content = this._rightPanelTabs.get("Validate Data");
        return content ? {icon: 'Validation', label: 'Validation Rules', content} : null;
      }
      case 'none':
      default: {
        return null;
      }
    }
  }

  private async _replaceViewSection(section: ViewSectionRec, newVal: IPageWidget) {

    const docModel = this.docModel;
    const viewModel = section.view();
    const docData = this.docModel.docData;

    // we must read the current layout from the view layout because it can override the one in
    // `section.layoutSpec` (in particular it provides a default layout when missing from the
    // latter).
    const layoutSpec = this._viewLayout!.layoutSpec();

    const sectionTitle = section.title();
    const sectionId = section.id();

    // create a new section
    const sectionCreationResult = await this.addWidgetToPageImpl(newVal);

    // update section name
    const newSection: ViewSectionRec = docModel.viewSections.getRowModel(sectionCreationResult.sectionRef);
    await newSection.title.saveOnly(sectionTitle);

    // replace old section id with new section id in the layout spec and save
    const newLayoutSpec = cloneDeepWith(layoutSpec, (val) => {
      if (typeof val === 'object' && val.leaf === sectionId) {
        return {...val, leaf: newSection.id()};
      }
    });
    await viewModel.layoutSpec.saveOnly(JSON.stringify(newLayoutSpec));

    // The newly-added section should be given focus.
    this.viewModel.activeSectionId(newSection.getRowId());

    // remove old section
    await docData.sendAction(['RemoveViewSection', sectionId]);
  }

  /**
   * Helper called before an action is sent to the server. It saves cursor position to come back to
   * in case of Undo.
   */
  private _onSendActionsStart(ev: {cursorPos: CursorPos}) {
    this._lastOwnActionGroup = null;
    ev.cursorPos = this.getCursorPos();
  }

  /**
   * Helper called when server responds to an action. It attaches the saved cursor position to the
   * received action (if any), and stores also the resulting position.
   */
  private _onSendActionsEnd(ev: {cursorPos: CursorPos}) {
    const a = this._lastOwnActionGroup;
    if (a) {
      a.cursorPos = ev.cursorPos;
      if (a.rowIdHint) {
        a.cursorPos.rowId = a.rowIdHint;
      }
    }
  }

  /**
   * Switch to a given sectionId, wait for it to load, and return a Promise for the instantiated
   * viewInstance (such as an instance of GridView or DetailView).
   */
  private async _switchToSectionId(sectionId: number) {
    const section: ViewSectionRec = this.docModel.viewSections.getRowModel(sectionId);
    if (section.isRaw.peek()) {
      // This is raw data view
      await urlState().pushUrl({docPage: 'data'});
      this.viewModel.activeSectionId(sectionId);
    } else {
      const view: ViewRec = section.view.peek();
      await this.openDocPage(view.getRowId());
      view.activeSectionId(sectionId);  // this.viewModel will reflect this with a delay.
    }

    // Returns the value of section.viewInstance() as soon as it is truthy.
    return waitObs(section.viewInstance);
  }

  private async _getTableData(section: ViewSectionRec): Promise<TableData> {
    const viewInstance = await waitObs(section.viewInstance);
    if (!viewInstance) { throw new Error('view not found'); }
    await viewInstance.getLoadingDonePromise();
    const table = this.docData.getTable(section.table.peek().tableId.peek());
    if (!table) { throw new Error('no section table'); }
    return table;
  }

  /**
   * Convert a url hash to a cursor position.
   */
  private _getCursorPosFromHash(hash: HashLink): CursorPos {
    const cursorPos: CursorPos = { rowId: hash.rowId, sectionId: hash.sectionId };
    if (cursorPos.sectionId != undefined && hash.colRef !== undefined){
      // translate colRef to a fieldIndex
      const section = this.docModel.viewSections.getRowModel(cursorPos.sectionId);
      const fieldIndex = section.viewFields.peek().all()
          .findIndex(x=> x.colRef.peek() == hash.colRef);
      if (fieldIndex >= 0) { cursorPos.fieldIndex = fieldIndex; }
    }
    return cursorPos;
  }

  /**
   * For first-time users on personal org, start a welcome tour.
   */
  private _shouldAutoStartWelcomeTour(): boolean {
    // When both a docTour and grist welcome tour are available, show only the docTour, leaving
    // the welcome tour for another doc (e.g. a new one).
    if (this.hasDocTour.get()) {
      return false;
    }

    // Only show the tour if one is on a personal org and can edit. This excludes templates (on
    // the Templates org, which may have their own tour) and team sites (where user's intended
    // role is often other than document creator).
    const appModel = this.docPageModel.appModel;
    if (!appModel.currentOrg?.owner || this.isReadonly.get()) {
      return false;
    }
    // Use the showGristTour pref if set; otherwise default to true for anonymous users, and false
    // for real returning users.
    return this._showGristTour.get() ?? (!appModel.currentValidUser);
  }

  /**
   * Makes sure that the first y-series (ie: the view fields at index 1) is a numeric series. Does
   * not handle chart with the group by option on: it is only intended to be used to make sure that
   * newly created chart do have a visible y series.
   */
  private async _ensureOneNumericSeries(id: number) {
    const viewSection = this.docModel.viewSections.getRowModel(id);
    const viewFields = viewSection.viewFields.peek().peek();

    // If no y-series, then simply return.
    if (viewFields.length === 1) { return; }

    const field = viewSection.viewFields.peek().peek()[1];
    if (isNumericOnly(viewSection.chartTypeDef.peek()) &&
        !isNumericLike(field.column.peek())) {
      const actions: UserAction[] = [];

      // remove non-numeric field
      actions.push(['RemoveRecord', field.id.peek()]);

      // add new field
      const newField = viewSection.hiddenColumns.peek().find((col) => isNumericLike(col));
      if (newField) {
        const colInfo = {
          parentId: viewSection.id.peek(),
          colRef: newField.id.peek(),
        };
        actions.push(['AddRecord', null, colInfo]);
      }

      // send actions
      await this.docModel.viewFields.sendTableActions(actions);
    }
  }
}

async function finalizeAnchor() {
  await urlState().pushUrl({ hash: {} }, { replace: true });
  setTestState({anchorApplied: true});
}

const cssViewContentPane = styled('div', `
  flex: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-width: 240px;
  margin: 12px;
  @media ${mediaSmall} {
    & {
      margin: 4px;
    }
  }
  @media print {
    & {
      margin: 0px;
    }
  }
  &-contents {
    margin: 0px;
  }
`);
