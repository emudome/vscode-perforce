import * as vscode from "vscode";
import { l10n } from "vscode";

import * as PerforceUri from "../PerforceUri";
import * as p4 from "../api/PerforceApi";

import * as qp from "./QuickPickProvider";
import { showQuickPickForChangelist } from "./ChangeQuickPick";
import { Job } from "../api/PerforceApi";
import { Display } from "../Display";
import { jobSpecEditor } from "../SpecEditor";

const nbsp = "\xa0";

export const jobQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        resourceOrStr: vscode.Uri | string,
        job: string
    ): Promise<qp.ActionableQuickPick> => {
        const resource = qp.asUri(resourceOrStr);
        const jobInfo = await p4.getJob(resource, { existingJob: job });
        if (jobInfo.description === "<enter description here>") {
            Display.showImportantError(l10n.t("Job {0} does not exist", job));
            throw new Error("Job " + job + " does not exist");
        }
        const clipItems = makeClipboardPicks(jobInfo);

        const fixItems = await makeFixesPicks(resource, job);

        const showJobItem = {
            label: l10n.t("$(file) Show job"),
            description: l10n.t("Open the full job spec in the editor"),
            performAction: () => {
                const uri = PerforceUri.forCommand(resource, "job", "-o " + job);
                vscode.window.showTextDocument(uri);
            },
        };
        const editJobItem = {
            label: l10n.t("$(edit) Edit job"),
            description: l10n.t("Edit the full job spec in the editor"),
            performAction: () => jobSpecEditor.editSpec(resource, job),
        };

        return {
            items: [...clipItems, showJobItem, editJobItem, ...fixItems],
            placeHolder: l10n.t(
                "Job {0} ({1}) by {2} : {3}",
                jobInfo.job ?? "",
                jobInfo.status ?? "",
                jobInfo.user ?? "",
                jobInfo.description ?? ""
            ),
        };
    },
};

export async function showQuickPickForJob(resource: vscode.Uri, job: string) {
    await qp.showQuickPick("job", resource, job);
}

async function makeFixesPicks(
    resource: vscode.Uri,
    job: string
): Promise<qp.ActionableQuickPickItem[]> {
    const fixes = await p4.fixes(resource, { job });
    const described =
        fixes.length > 0
            ? await p4.describe(resource, {
                  omitDiffs: true,
                  chnums: fixes.map((fix) => fix.chnum),
              })
            : [];
    const fixedByItem = {
        label: l10n.t("Fixed by changelists: {0}", fixes.length),
    };
    const fixItems = fixes.map((fix) => {
        const change = described.find((d) => d.chnum === fix.chnum);
        return {
            label:
                nbsp.repeat(3) +
                (change?.isPending ? "$(tools) " : "$(check) ") +
                fix.chnum,
            description:
                "$(person) " +
                fix.user +
                " $(calendar) " +
                fix.date +
                " $(book) " +
                change?.description.join(" "),
            performAction: () => {
                showQuickPickForChangelist(resource, fix.chnum);
            },
        };
    });
    return [fixedByItem, ...fixItems];
}

function makeClipboardPicks(jobInfo: Job): qp.ActionableQuickPickItem[] {
    return [
        qp.makeClipPick(l10n.t("job id"), jobInfo.job),
        qp.makeClipPick(l10n.t("description"), jobInfo.description),
        qp.makeClipPick(l10n.t("user"), jobInfo.user),
    ];
}
