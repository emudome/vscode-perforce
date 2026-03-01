// Type augmentation for vscode.l10n API (available since VS Code 1.73)
// This allows using the l10n API with older @types/vscode versions.
declare module "vscode" {
    /**
     * The l10n namespace provides localization support for the extension.
     */
    export namespace l10n {
        /**
         * Marks a string for localization. If a localized bundle is available
         * for the language specified by {@link env.language} and a localized
         * value for this message is found in that bundle, it will be returned
         * (with injected args values for any templated values).
         *
         * @param message - The message to localize
         * @param args - The arguments to be used in the localized string
         * @returns The localized string
         */
        export function t(
            message: string,
            ...args: (string | number | boolean)[]
        ): string;

        /**
         * Marks a string for localization. If a localized bundle is available
         * for the language specified by {@link env.language} and a localized
         * value for this message is found in that bundle, it will be returned
         * (with injected args values for any templated values).
         *
         * @param message - The message to localize
         * @param args - A record of named arguments to be used in the localized string
         * @returns The localized string
         */
        export function t(
            message: string,
            args: Record<string, string | number | boolean>
        ): string;

        /**
         * Marks a string for localization. If a localized bundle is available
         * for the language specified by {@link env.language} and a localized
         * value for this message is found in that bundle, it will be returned
         * (with injected args values for any templated values).
         *
         * @param options - The options to use when localizing the message
         * @returns The localized string
         */
        export function t(options: {
            message: string;
            args?:
                | (string | number | boolean)[]
                | Record<string, string | number | boolean>;
            comment: string | string[];
        }): string;

        /**
         * The bundle of localized strings that have been loaded for the extension.
         */
        export const bundle: { [key: string]: string } | undefined;

        /**
         * The URI of the localization bundle that has been loaded for the extension.
         */
        export const uri: Uri | undefined;
    }
}
