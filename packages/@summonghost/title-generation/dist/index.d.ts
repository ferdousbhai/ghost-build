export declare const MAX_GENERATED_TITLE_CHARACTERS = 60;
type TitleSubject = "conversation" | "project";
type TitleGenerationPromptInput = Readonly<{
    firstPrompt: string;
    subject?: TitleSubject;
}>;
export type TitleGenerationExecutionRequest = Readonly<{
    prompt: string;
    maxOutputTokens: number;
    temperature: number;
}>;
type TitleGenerationTextResult = Readonly<{
    text: string;
}>;
export type GenerateTitleInput<Result extends TitleGenerationTextResult> = TitleGenerationPromptInput & Readonly<{
    execute: (request: TitleGenerationExecutionRequest) => Promise<Result>;
}>;
export type GenerateTitleResult<Result extends TitleGenerationTextResult> = Readonly<{
    result: Result;
    title: string | null;
}>;
/** Build an immediate, deterministic label before any model request. */
export declare function deriveProvisionalTitle(rawFirstPrompt: string | null | undefined): string | null;
/**
 * Execute one consumer-injected title-model request with the shared prompt,
 * limits, and output validation.
 */
export declare function generateTitle<Result extends TitleGenerationTextResult>(input: GenerateTitleInput<Result>): Promise<GenerateTitleResult<Result> | null>;
/** Normalize and validate the raw text returned by a title model. */
export declare function normalizeGeneratedTitle(text: string): string | null;
export {};
//# sourceMappingURL=index.d.ts.map