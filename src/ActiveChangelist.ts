import {
    window,
    StatusBarAlignment,
    StatusBarItem,
    EventEmitter,
    Disposable,
    l10n,
} from "vscode";
import * as vscode from "vscode";
import { MementoItem, MementoKeys } from "./MementoItem";
import { configAccessor } from "./ConfigService";
import { Display } from "./Display";
import * as p4 from "./api/PerforceApi";

/**
 * Represents the state of the active changelist for a single Model (workspace folder).
 */
interface ModelActiveState {
    /** The selected active changelist number, or undefined if not selected */
    chnum: string | undefined;
    /** MementoItem for persisting the active changelist across sessions */
    memento: MementoItem<string>;
    /** The workspace URI associated with this model */
    workspaceUri: vscode.Uri;
    /** The client name for this model */
    clientName: string;
    /** Currently known pending changelist numbers (updated from Model) */
    pendingChnums: string[];
    /** Descriptions for pending changelists */
    pendingDescriptions: Map<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ActiveChangelist {
    let _statusBarItem: StatusBarItem;
    const _states: Map<string, ModelActiveState> = new Map();

    /** Key for the currently active editor's model (clientName) */
    let _currentModelKey: string | undefined;

    const _onDidChangeActiveChangelist = new EventEmitter<{
        clientName: string;
        chnum: string | undefined;
    }>();
    export const onDidChangeActiveChangelist = _onDidChangeActiveChangelist.event;

    let _disposables: Disposable[] = [];

    /**
     * Initialize the ActiveChangelist status bar item and related disposables.
     */
    export function initialize(subscriptions: Disposable[]) {
        _statusBarItem = window.createStatusBarItem(
            StatusBarAlignment.Left,
            Number.MIN_VALUE + 1
        );
        _statusBarItem.command = "perforce.selectActiveChangelist";
        subscriptions.push(_statusBarItem);
        subscriptions.push(_onDidChangeActiveChangelist);

        subscriptions.push(
            vscode.commands.registerCommand(
                "perforce.selectActiveChangelist",
                showChangelistPicker
            )
        );

        subscriptions.push(
            window.onDidChangeActiveTextEditor(() => {
                updateStatusBarForActiveEditor();
            })
        );
    }

    /**
     * Register a model (workspace folder) with the ActiveChangelist system.
     * Call this when an SCM provider is initialized.
     */
    export function registerModel(
        workspaceUri: vscode.Uri,
        clientName: string,
        workspaceState: vscode.Memento
    ) {
        const key = clientName;
        if (_states.has(key)) {
            return;
        }

        const mementoKey = MementoKeys.ACTIVE_CHANGELIST + "." + clientName;
        const memento = new MementoItem<string>(mementoKey, workspaceState);

        const state: ModelActiveState = {
            chnum: memento.value,
            memento,
            workspaceUri,
            clientName,
            pendingChnums: [],
            pendingDescriptions: new Map(),
        };

        _states.set(key, state);
        updateStatusBarForActiveEditor();
    }

    /**
     * Unregister a model when its SCM provider is disposed.
     */
    export function unregisterModel(clientName: string) {
        _states.delete(clientName);
        if (_currentModelKey === clientName) {
            _currentModelKey = undefined;
            updateStatusBar(undefined);
        }
    }

    /**
     * Called by Model after refresh to update the known pending changelist numbers.
     */
    export function updatePendingChangelists(
        clientName: string,
        pendingChnums: string[],
        pendingDescriptions: Map<string, string>
    ) {
        const state = _states.get(clientName);
        if (!state) {
            return;
        }

        state.pendingChnums = pendingChnums;
        state.pendingDescriptions = pendingDescriptions;

        // Validate that the active CL still exists
        if (state.chnum && !pendingChnums.includes(state.chnum)) {
            // Active CL has disappeared — will be handled on next checkout attempt
            // Don't clear it here so we can detect the disappearance and notify user
        }

        updateStatusBarForActiveEditor();
    }

    /**
     * Get the active changelist number for a given client.
     * Returns undefined if the feature is disabled or no active CL is set.
     */
    export function getActiveChangelist(clientName: string): string | undefined {
        if (!configAccessor.avoidDefaultChangelist) {
            return undefined;
        }
        return _states.get(clientName)?.chnum;
    }

    /**
     * Set the active changelist for a given client.
     */
    export async function setActiveChangelist(
        clientName: string,
        chnum: string | undefined
    ) {
        const state = _states.get(clientName);
        if (!state) {
            return;
        }

        state.chnum = chnum;
        await state.memento.save(chnum);
        _onDidChangeActiveChangelist.fire({ clientName, chnum });
        updateStatusBarForActiveEditor();
    }

    /**
     * Resolve the changelist number to use for an edit/add operation.
     *
     * @param clientName - The client name of the model
     * @param workspaceUri - The workspace URI for running p4 commands
     * @param isAutomatic - true for automatic operations (file save, etc.), false for manual
     * @returns The changelist number to use, or undefined to use default changelist
     */
    export async function resolveChangelist(
        clientName: string,
        workspaceUri: vscode.Uri,
        isAutomatic: boolean
    ): Promise<string | undefined> {
        if (!configAccessor.avoidDefaultChangelist) {
            return undefined;
        }

        const state = _states.get(clientName);
        if (!state) {
            return undefined;
        }

        // Case 1: Active CL is set and still exists
        if (state.chnum && state.pendingChnums.includes(state.chnum)) {
            return state.chnum;
        }

        // Case 2: Active CL was set but has disappeared
        if (state.chnum && !state.pendingChnums.includes(state.chnum)) {
            const oldChnum = state.chnum;
            const newChnum = await createChangelistWithDefaultDescription(workspaceUri);
            if (newChnum) {
                await setActiveChangelist(clientName, newChnum);
                window.showWarningMessage(
                    l10n.t(
                        "Changelist #{0} no longer exists. Created new changelist #{1}.",
                        oldChnum,
                        newChnum
                    )
                );
                return newChnum;
            }
            // Failed to create — clear the stale reference
            await setActiveChangelist(clientName, undefined);
            return undefined;
        }

        // Case 3: No active CL set — check how many numbered CLs exist
        const pendingCount = state.pendingChnums.length;

        if (pendingCount === 0) {
            // No numbered changelists exist — create one
            if (isAutomatic) {
                const newChnum = await createChangelistWithDefaultDescription(
                    workspaceUri
                );
                if (newChnum) {
                    await setActiveChangelist(clientName, newChnum);
                    return newChnum;
                }
                return undefined;
            } else {
                // Manual operation — prompt for description
                const description = await window.showInputBox({
                    prompt: l10n.t(
                        "No numbered changelist exists. Enter a description to create one:"
                    ),
                    value: configAccessor.defaultChangelistDescription,
                    validateInput: (val) => {
                        if (!val.trim()) {
                            return l10n.t("Description must not be empty");
                        }
                    },
                });
                if (!description) {
                    return undefined; // User cancelled
                }
                const newChnum = await createChangelist(workspaceUri, description);
                if (newChnum) {
                    await setActiveChangelist(clientName, newChnum);
                    return newChnum;
                }
                return undefined;
            }
        } else if (pendingCount === 1) {
            // Exactly one numbered CL — auto-select it
            const onlyChnum = state.pendingChnums[0];
            await setActiveChangelist(clientName, onlyChnum);
            return onlyChnum;
        } else {
            // Multiple numbered CLs — need selection
            if (isAutomatic) {
                // Pick the most recent (highest numbered) CL
                const sorted = [...state.pendingChnums].sort(
                    (a, b) => parseInt(b) - parseInt(a)
                );
                const newest = sorted[0];
                await setActiveChangelist(clientName, newest);
                const desc = state.pendingDescriptions.get(newest) ?? "";
                window.showInformationMessage(
                    l10n.t(
                        "Auto-selected changelist #{0} ({1}) as the active changelist.",
                        newest,
                        desc
                    )
                );
                return newest;
            } else {
                // Manual operation — show QuickPick
                const picked = await showChangelistPickerForState(state);
                return picked;
            }
        }
    }

    /**
     * Show the changelist picker QuickPick (triggered from status bar or manual operation).
     */
    async function showChangelistPicker() {
        const state = getCurrentState();
        if (!state) {
            window.showInformationMessage(l10n.t("No active perforce workspace found."));
            return;
        }

        await showChangelistPickerForState(state);
    }

    async function showChangelistPickerForState(
        state: ModelActiveState
    ): Promise<string | undefined> {
        interface CLQuickPickItem {
            id: string;
            label: string;
            description?: string;
        }

        const items: CLQuickPickItem[] = [];

        // Add "New Changelist..." option
        items.push({
            id: "new",
            label: "$(add) " + l10n.t("New Changelist..."),
            description: "",
        });

        // Add existing numbered CLs
        for (const chnum of state.pendingChnums) {
            const desc = state.pendingDescriptions.get(chnum) ?? "";
            const isActive = state.chnum === chnum;
            items.push({
                id: chnum,
                label: (isActive ? "$(check) " : "     ") + "#" + chnum,
                description: desc,
            });
        }

        const selection = await window.showQuickPick(items, {
            placeHolder: l10n.t("Select the active changelist for edit/add operations"),
            matchOnDescription: true,
        });

        if (!selection) {
            return state.chnum;
        }

        if (selection.id === "new") {
            const description = await window.showInputBox({
                prompt: l10n.t("Enter the new changelist description"),
                value: configAccessor.defaultChangelistDescription,
                validateInput: (val) => {
                    if (!val.trim()) {
                        return l10n.t("Description must not be empty");
                    }
                },
            });
            if (!description) {
                return state.chnum;
            }
            const newChnum = await createChangelist(state.workspaceUri, description);
            if (newChnum) {
                await setActiveChangelist(state.clientName, newChnum);
                return newChnum;
            }
            return state.chnum;
        } else {
            await setActiveChangelist(state.clientName, selection.id);
            return selection.id;
        }
    }

    /**
     * Create a changelist with the default description from settings.
     */
    async function createChangelistWithDefaultDescription(
        workspaceUri: vscode.Uri
    ): Promise<string | undefined> {
        const description = configAccessor.defaultChangelistDescription;
        return createChangelist(workspaceUri, description);
    }

    /**
     * Create a new empty changelist with the given description.
     */
    async function createChangelist(
        workspaceUri: vscode.Uri,
        description: string
    ): Promise<string | undefined> {
        try {
            const changeFields = await p4.getChangeSpec(workspaceUri, {});
            changeFields.files = [];
            changeFields.description = description;
            const created = await p4.inputChangeSpec(workspaceUri, {
                spec: changeFields,
            });
            Display.showMessage(l10n.t("Created changelist #{0}", created.chnum ?? ""));
            return created.chnum;
        } catch (err) {
            Display.showImportantError(String(err));
            return undefined;
        }
    }

    /**
     * Get the state for the currently active editor's model.
     */
    function getCurrentState(): ModelActiveState | undefined {
        if (_currentModelKey) {
            return _states.get(_currentModelKey);
        }
        // Fall back to first registered state
        if (_states.size > 0) {
            return _states.values().next().value;
        }
        return undefined;
    }

    /**
     * Update the _currentModelKey based on the active editor, then update the status bar.
     */
    function updateStatusBarForActiveEditor() {
        if (!configAccessor.avoidDefaultChangelist) {
            _statusBarItem?.hide();
            return;
        }

        const editor = window.activeTextEditor;
        if (!editor || editor.document.isUntitled) {
            // Use last known or first available
            const state = getCurrentState();
            updateStatusBar(state);
            return;
        }

        const fileUri = editor.document.uri;

        // Find the matching state by checking if the file is under the workspace URI
        for (const [key, state] of _states) {
            const wsPath = state.workspaceUri.fsPath;
            if (fileUri.fsPath.startsWith(wsPath)) {
                _currentModelKey = key;
                updateStatusBar(state);
                return;
            }
        }

        // No match found - use current or first
        const state = getCurrentState();
        updateStatusBar(state);
    }

    /**
     * Update the status bar display based on the given state.
     */
    function updateStatusBar(state: ModelActiveState | undefined) {
        if (!_statusBarItem) {
            return;
        }

        if (!configAccessor.avoidDefaultChangelist || !state) {
            _statusBarItem.hide();
            return;
        }

        if (state.chnum && state.pendingChnums.includes(state.chnum)) {
            const desc = state.pendingDescriptions.get(state.chnum) ?? "";
            _statusBarItem.text = "$(list-unordered) CL #" + state.chnum;
            _statusBarItem.tooltip = l10n.t(
                "Active Changelist: #{0} - {1}\nClick to change",
                state.chnum,
                desc
            );
        } else if (state.pendingChnums.length === 0) {
            _statusBarItem.text = "$(list-unordered) CL: New...";
            _statusBarItem.tooltip = l10n.t(
                "No numbered changelists. Click to create one."
            );
        } else {
            _statusBarItem.text = "$(list-unordered) CL: Select...";
            _statusBarItem.tooltip = l10n.t(
                "No active changelist selected. Click to select one."
            );
        }

        _statusBarItem.show();
    }

    /**
     * Find the client name for a file URI by checking registered states.
     */
    export function getClientNameForUri(fileUri: vscode.Uri): string | undefined {
        for (const [key, state] of _states) {
            const wsPath = state.workspaceUri.fsPath;
            if (fileUri.fsPath.startsWith(wsPath)) {
                return key;
            }
        }
        return undefined;
    }

    /**
     * Get the workspace URI for a given client name.
     */
    export function getWorkspaceUriForClient(clientName: string): vscode.Uri | undefined {
        return _states.get(clientName)?.workspaceUri;
    }

    export function dispose() {
        _disposables.forEach((d) => d.dispose());
        _disposables = [];
        _states.clear();
    }
}
