export class DeploymentValidationStore {
  #fullValidationRevision: string | null = null;

  beginFullValidation(): void {
    this.#fullValidationRevision = null;
  }

  recordFullValidation(revision: string): void {
    this.#fullValidationRevision = revision;
  }

  hasFullValidation(revision: string): boolean {
    return this.#fullValidationRevision === revision;
  }
}
