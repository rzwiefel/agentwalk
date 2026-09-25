// Minimal type surface for redact.mjs so TypeScript test files (which cannot
// use allowJs) can import the module. Keep this in sync with the actual named
// exports in redact.mjs -- it declares shape only, it does not run anything.
export declare const SECRET_KEY: RegExp;
export declare const SENSITIVE_ASSIGNMENT: RegExp;
export declare function redactString(value: unknown, options?: { preservePaths?: boolean }): string;
export declare function redactMetadata(value: unknown, depth?: number): unknown;
export declare function redactError(error: unknown): { classification: string; code?: string } | undefined;
