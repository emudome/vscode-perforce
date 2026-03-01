import * as vscode from "vscode";
import * as p4 from "../api/PerforceApi";

import * as PerforceUri from "../PerforceUri";
import * as DiffProvider from "../DiffProvider";
import { isTruthy } from "../TsUtils";
import { toReadableDateTime } from "../DateFormatter";
import { configAccessor } from "../ConfigService";

const _config = configAccessor;

export function codicon(name: string) {
    return "$(" + name + ")";
}

export function makeSwarmHostURL(change: p4.FileLogItem) {
    return (
        _config.getSwarmLink(change.chnum) +
        ' "' +
        vscode.l10n.t("Open in review tool") +
        '"'
    );
}

function makeCommandURI(command: string, ...args: any[]) {
    const encoded = encodeURIComponent(JSON.stringify(args));
    return "command:" + command + "?" + encoded;
}

export function makeDiffURI(
    workspace: vscode.Uri,
    prevChange: p4.FileLogItem,
    change: p4.FileLogItem
) {
    const args = [
        makePerforceURI(workspace, prevChange),
        makePerforceURI(workspace, change),
    ];
    return (
        makeCommandURI("perforce.diffFiles", ...args) +
        ' "' +
        DiffProvider.diffTitleForDepotPaths(
            prevChange.file,
            prevChange.revision,
            change.file,
            change.revision
        ) +
        '"'
    );
}

function makePerforceURI(underlying: vscode.Uri, change: p4.FileLogItem) {
    return PerforceUri.fromDepotPath(underlying, change.file, change.revision);
}

function makeQuickPickFileURI(underlying: vscode.Uri, change: p4.FileLogItem) {
    return (
        makeCommandURI(
            "perforce.showQuickPick",
            "file",
            makePerforceURI(underlying, change)
        ) +
        ' "' +
        vscode.l10n.t("Show more actions for this file") +
        '"'
    );
}

function makeQuickPickChangeURI(underlying: vscode.Uri, change: p4.FileLogItem) {
    return (
        makeCommandURI("perforce.showQuickPick", "change", underlying, change.chnum) +
        ' "' +
        vscode.l10n.t("Show actions for changelist {0}", change.chnum) +
        '"'
    );
}

export function makeAnnotateURI(underlying: vscode.Uri, change: p4.FileLogItem) {
    const args = makePerforceURI(underlying, change);
    return (
        makeCommandURI("perforce.annotate", args) +
        ' "' +
        vscode.l10n.t("Show annotations for {0}#{1}", change.file, change.revision) +
        '"'
    );
}

export function makeMarkdownLink(text: string, link: string, withoutBrackets?: boolean) {
    return withoutBrackets
        ? "[" + text + "](" + link + ")"
        : "\\[[" + text + "](" + link + ")\\]";
}

export function makeAllLinks(
    underlying: vscode.Uri,
    change: p4.FileLogItem,
    latestChange: p4.FileLogItem,
    prevChange?: p4.FileLogItem
) {
    const diffLink = prevChange
        ? makeMarkdownLink(
              vscode.l10n.t("Diff Previous"),
              makeDiffURI(underlying, prevChange, change)
          )
        : undefined;
    const diffLatestLink =
        change !== latestChange
            ? makeMarkdownLink(
                  vscode.l10n.t("Diff this Revision"),
                  makeDiffURI(underlying, change, latestChange)
              )
            : undefined;
    const annotateLink = prevChange
        ? makeMarkdownLink(
              vscode.l10n.t("Annotate Previous"),
              makeAnnotateURI(underlying, prevChange)
          )
        : undefined;
    const swarmLink = _config.swarmHost
        ? makeMarkdownLink(codicon("eye"), makeSwarmHostURL(change), true)
        : undefined;
    const moreLink = makeMarkdownLink(
        "…",
        makeQuickPickFileURI(underlying, change),
        true
    );

    return [diffLink, diffLatestLink, annotateLink, swarmLink, moreLink]
        .filter(isTruthy)
        .join(" ");
}

function doubleUpNewlines(str: string) {
    return str.replace(/\n+/g, "\n\n");
}

export function makeUserAndDateSummary(underlying: vscode.Uri, change: p4.FileLogItem) {
    return (
        change.file +
        "#" +
        change.revision +
        "\n\n" +
        makeMarkdownLink(
            vscode.l10n.t("Change {0}", change.chnum),
            makeQuickPickChangeURI(underlying, change),
            true
        ) +
        " by **`" +
        change.user +
        "`** on `" +
        toReadableDateTime(change.date) +
        "`"
    );
}

export function convertToMarkdown(description: string) {
    return doubleUpNewlines(description);
}
