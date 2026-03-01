import * as vscode from "vscode";
import { l10n } from "vscode";

import * as PerforceUri from "../PerforceUri";
import * as p4 from "../api/PerforceApi";

import * as qp from "./QuickPickProvider";
import { Display } from "../Display";
import { DescribedChangelist } from "../api/PerforceApi";
import { showQuickPickForFile } from "./FileQuickPick";
import { toReadableDateTime } from "../DateFormatter";
import { configAccessor } from "../ConfigService";
import { focusChangelist } from "../search/ChangelistTreeView";
import { PerforceSCMProvider } from "../ScmProvider";
import { pluralise, isTruthy } from "../TsUtils";
import { showQuickPickForShelvedFile } from "./ShelvedFileQuickPick";
import { showQuickPickForJob } from "./JobQuickPick";
import { changeSpecEditor } from "../SpecEditor";

const nbsp = "\xa0";

export const changeQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        resourceOrStr: vscode.Uri | string,
        chnum: string
    ): Promise<qp.ActionableQuickPick> => {
        const resource = qp.asUri(resourceOrStr);
        const changes = await p4.describe(resource, {
            chnums: [chnum],
            omitDiffs: true,
        });

        if (changes.length < 1) {
            Display.showImportantError(l10n.t("Unable to find change details"));
            throw new Error("Unable to find change details");
        }

        const change = changes[0];

        const shelvedChanges = change.isPending
            ? await p4.describe(resource, {
                  omitDiffs: true,
                  shelved: true,
                  chnums: [chnum],
              })
            : [];

        const shelvedChange = shelvedChanges[0];
        const actions = makeFocusPick(resource, change).concat(
            makeSwarmPick(change),
            makeClipboardPicks(resource, change),
            makeEditPicks(resource, change),
            makeUnshelvePicks(resource, shelvedChange),
            makeJobPicks(resource, change),
            makeFilePicks(resource, change),
            makeShelvedFilePicks(resource, shelvedChange)
        );

        return {
            items: actions,
            placeHolder: l10n.t(
                "{0} change {1} by {2} on {3} : {4}",
                change.isPending ? l10n.t("Pending") : l10n.t("Submitted"),
                chnum,
                change.user,
                toReadableDateTime(change.date),
                change.description.join(" ")
            ),
        };
    },
};

async function unshelveAndRefresh(resource: vscode.Uri, options: p4.UnshelveOptions) {
    try {
        const output = await p4.unshelve(resource, options);
        Display.showMessage(l10n.t("Changelist unshelved"));
        PerforceSCMProvider.RefreshAll();
        if (output.warnings.length > 0) {
            const resolveButton: string | undefined = options.toChnum
                ? l10n.t("Resolve changelist")
                : undefined;
            const chosen = await vscode.window.showWarningMessage(
                l10n.t(
                    "Changelist #{0} was unshelved, but {1} resolving",
                    options.shelvedChnum,
                    pluralise(output.warnings.length, "file needs", 0, "files need")
                ),
                ...[resolveButton].filter(isTruthy)
            );
            if (chosen && chosen === resolveButton) {
                await p4.resolve(resource, { chnum: options.toChnum });
            }
        }
    } catch (err) {
        Display.showImportantError(err);
        PerforceSCMProvider.RefreshAll();
    }
}

export const unshelveChangeQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        resourceOrStr: vscode.Uri | string,
        chnum: string,
        clobber: boolean = true,
        branchMapping?: string
    ): Promise<qp.ActionableQuickPick> => {
        const resource = qp.asUri(resourceOrStr);
        const defaultChangelistAction: qp.ActionableQuickPickItem = {
            label: l10n.t("Default changelist"),
            description: l10n.t(
                "Unshelve into the default changelist, or the current changelist if already unshelved"
            ),
            performAction: () =>
                unshelveAndRefresh(resource, {
                    shelvedChnum: chnum,
                    branchMapping,
                    force: clobber,
                }),
        };
        const newChangelistAction: qp.ActionableQuickPickItem = {
            label: l10n.t("New changelist"),
            description: l10n.t("Unshelve into a new changelist"),
            performAction: async () => {
                const spec = await p4.getChangeSpec(resource, {});
                spec.description = "Unshelved from change #" + chnum;
                spec.files = [];
                const newChange = await p4.inputChangeSpec(resource, { spec });
                await unshelveAndRefresh(resource, {
                    shelvedChnum: chnum,
                    toChnum: newChange.chnum,
                    branchMapping,
                    force: clobber,
                });
            },
        };
        const changelistActions = await getUnshelveChangelistPicks(
            resource,
            chnum,
            clobber,
            branchMapping
        );
        return {
            items: [defaultChangelistAction, newChangelistAction, ...changelistActions],
            excludeFromHistory: true,
            placeHolder:
                (branchMapping
                    ? l10n.t(
                          "Unshelve changelist {0} through branch {1} into...",
                          chnum,
                          branchMapping
                      )
                    : l10n.t("Unshelve changelist {0} into...", chnum)) +
                (clobber ? " " + l10n.t("(WILL CLOBBER WRITABLE FILES)") : ""),
        };
    },
};

async function getUnshelveChangelistPicks(
    resource: vscode.Uri,
    chnum: string,
    clobber: boolean,
    branchMapping?: string
) {
    const info = await p4.getInfo(resource, {});
    const user = info.get("User name");

    if (!user) {
        return [];
    }

    const changelists = await p4.getChangelists(resource, {
        user,
        status: p4.ChangelistStatus.PENDING,
    });
    return changelists.map<qp.ActionableQuickPickItem>((c) => {
        return {
            label: c.chnum,
            description: c.description.join(" "),
            performAction: () =>
                unshelveAndRefresh(resource, {
                    shelvedChnum: chnum,
                    toChnum: c.chnum,
                    branchMapping,
                    force: clobber,
                }),
        };
    });
}

export async function showUnshelveQuickPick(
    resource: vscode.Uri,
    chnum: string,
    branchMapping?: string
) {
    return qp.showQuickPick("unshelveChange", resource, chnum, true, branchMapping);
}

export async function showQuickPickForChangelist(resource: vscode.Uri, chnum: string) {
    await qp.showQuickPick("change", resource, chnum);
}

export function getOperationIcon(operation: string) {
    switch (operation) {
        case "add":
            return "diff-added";
        case "delete":
        case "move/delete":
        case "purge":
            return "diff-removed";
        case "move/add":
        case "integrate":
        case "branch":
            return "diff-renamed";
        default:
            return "diff-modified";
    }
}

function makeFocusPick(
    resource: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: l10n.t("$(multiple-windows) Focus in changelist search view"),
            performAction: () => {
                focusChangelist(resource, change);
            },
        },
    ];
}

function makeSwarmPick(change: DescribedChangelist): qp.ActionableQuickPickItem[] {
    const swarmAddr = configAccessor.getSwarmLink(change.chnum);
    if (!swarmAddr) {
        return [];
    }

    try {
        const uri = vscode.Uri.parse(swarmAddr, true);
        return [
            {
                label: l10n.t("$(eye) Open in review tool"),
                description: "$(link-external) " + uri.toString(),
                performAction: () => {
                    vscode.env.openExternal(uri);
                },
            },
        ];
    } catch (err) {
        Display.showImportantError(
            l10n.t(
                "Could not parse swarm link {0} - make sure you have included the protocol, e.g. https://",
                swarmAddr
            )
        );
        return [];
    }
}

function makeEditPicks(
    uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: l10n.t("$(edit) Edit changelist"),
            description: l10n.t("Edit the full changelist spec in the editor"),
            performAction: () => {
                changeSpecEditor.editSpec(uri, change.chnum);
            },
        },
    ];
}

function makeClipboardPicks(
    _uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        qp.makeClipPick(l10n.t("change number"), change.chnum),
        qp.makeClipPick(l10n.t("user"), change.user),
        qp.makeClipPick(l10n.t("change description"), change.description.join("\n")),
    ];
}

function makeFilePicks(
    uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: l10n.t("Changed files: {0}", change.affectedFiles.length),
        },
    ].concat(
        change.affectedFiles.map<qp.ActionableQuickPickItem>((file) => {
            return {
                label:
                    nbsp.repeat(3) +
                    "$(" +
                    getOperationIcon(file.operation) +
                    ")" +
                    " " +
                    file.depotPath +
                    "#" +
                    file.revision,
                description: file.operation,
                performAction: () => {
                    const thisUri = PerforceUri.fromDepotPath(
                        PerforceUri.getUsableWorkspace(uri) ?? uri,
                        file.depotPath,
                        file.revision
                    );
                    showQuickPickForFile(thisUri);
                },
            };
        })
    );
}

async function searchForBranch(
    uri: vscode.Uri,
    branch: string
): Promise<string | undefined> {
    try {
        const branches = await p4.branches(uri, {
            max: 200,
            nameFilter: branch.replace("*", "..."),
        });
        if (branches.length < 1) {
            Display.showImportantError(l10n.t("No branch mappings match {0}", branch));
            return;
        }
        return await vscode.window.showQuickPick(
            branches.map((b) => b.branch),
            { placeHolder: l10n.t("Choose a matching branch") }
        );
    } catch (err) {
        Display.showImportantError(err);
    }
}

function makeUnshelvePicks(
    uri: vscode.Uri,
    change?: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    if (!change || change.shelvedFiles.length < 1) {
        return [];
    }
    return [
        {
            label: l10n.t("$(cloud-download) Unshelve changelist..."),
            description: l10n.t("Unshelve into a selected changelist"),
            performAction: () => {
                showUnshelveQuickPick(uri, change.chnum);
            },
        },
        {
            label: l10n.t("$(cloud-download) Unshelve via branch mapping..."),
            description: l10n.t("Unshelve, mapping through a branch spec"),
            performAction: async (reopen) => {
                const branch = await vscode.window.showInputBox({
                    prompt: l10n.t(
                        "Enter branch name to unshelve changelist {0} through (use * to search by wildcard)",
                        change.chnum
                    ),
                    ignoreFocusOut: true,
                });

                const chosen = branch?.includes("*")
                    ? await searchForBranch(uri, branch)
                    : branch;

                if (chosen === undefined) {
                    reopen();
                } else {
                    showUnshelveQuickPick(uri, change.chnum, chosen);
                }
            },
        },
    ];
}

function makeShelvedFilePicks(
    uri: vscode.Uri,
    change?: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    if (!change || change.shelvedFiles.length < 1) {
        return [];
    }
    return [
        {
            label: l10n.t("Shelved files: {0}", change.shelvedFiles.length),
        },
    ].concat(
        change.shelvedFiles.map<qp.ActionableQuickPickItem>((file) => {
            return {
                label:
                    nbsp.repeat(3) +
                    "$(" +
                    getOperationIcon(file.operation) +
                    ")" +
                    " " +
                    file.depotPath +
                    "#" +
                    file.revision,
                description: file.operation,
                performAction: () => {
                    showQuickPickForShelvedFile(
                        PerforceUri.getUsableWorkspace(uri) ?? uri,
                        file,
                        change
                    );
                },
            };
        })
    );
}

function makeJobPicks(
    uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: l10n.t("Jobs fixed: {0}", change.fixedJobs.length),
        },
    ].concat(
        change.fixedJobs.map<qp.ActionableQuickPickItem>((job) => {
            return {
                label: nbsp.repeat(3) + "$(tools) " + job.id,
                description: job.description.join(" "),
                performAction: () => {
                    showQuickPickForJob(uri, job.id);
                },
            };
        })
    );
}
