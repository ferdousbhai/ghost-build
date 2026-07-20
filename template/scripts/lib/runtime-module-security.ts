import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

const AMBIENT_WORKERS_MODULE = "cloudflare:workers";
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;

type RuntimeCapability =
  | "ambient-workers-module"
  | "dynamic-import"
  | "require-call"
  | "eval-call"
  | "function-constructor";

type RuntimeModuleSecurityViolation = {
  capability: RuntimeCapability;
  line: number;
  column: number;
};

type RuntimeModuleImportViolation = {
  importer: string;
  imported: string;
};

/**
 * Production bundles receive privileged Agent bindings, so every resolved
 * runtime module is inspected before Vite transforms it. The allowlist is
 * intentionally file- and capability-specific: reviewed framework modules
 * may use Worker primitives, but generated application modules and arbitrary
 * dependencies may not acquire the ambient environment or dynamic code.
 */
const REVIEWED_MODULE_CAPABILITIES = new Map<
  string,
  ReadonlySet<RuntimeCapability>
>([
  ["project:src/app-bindings.ts", new Set(["ambient-workers-module"])],
  ["package:agents@0.17.4/dist/index.js", new Set(["ambient-workers-module"])],
  [
    "package:partyserver@0.5.8/dist/index.js",
    new Set(["ambient-workers-module"]),
  ],
  [
    "package:ajv@8.20.0/dist/compile/index.js",
    new Set(["function-constructor"]),
  ],
  [
    "package:core-js-pure@3.49.0/internals/global-this.js",
    new Set(["function-constructor"]),
  ],
]);

const REVIEWED_PACKAGE_MODULE_SHA256 = new Map([
  [
    "package:agents@0.17.4/dist/index.js",
    "e80dca458031bf63d960fdad3881cf062da55512144ed4f5a00aa441586c2a48",
  ],
  [
    "package:partyserver@0.5.8/dist/index.js",
    "a15a4d1903c1696d288eb793cf29a0bd1fa2105ff10cde41648bb3dc2313bcc5",
  ],
  [
    "package:ajv@8.20.0/dist/compile/index.js",
    "05b34da22814f3787bfa3ac68dad59c9047f56e55a607e0a20719ebf5afe69ac",
  ],
  [
    "package:core-js-pure@3.49.0/internals/global-this.js",
    "48246f2542635417cf3f8c6bcf99d7a991668ea1284d869671fcb5b63a4af8c8",
  ],
  [
    "package:agents@0.17.4/dist/client-C7F0MaVz.js",
    "8d7a5ce2e0a4ea6caadb54b6206f977af9d4506230a4c508571b99cadddecf06",
  ],
]);

/**
 * These modules export mutable Worker handlers or Agent base classes. Letting
 * generated routes import them would allow a route's module initializer to
 * replace methods on the same objects used by the protected Worker runtime.
 * The application binding broker is intentionally absent from this set: it is
 * the narrow, reviewed surface generated routes are expected to import.
 */
const PRIVILEGED_RUNTIME_MODULES = new Set([
  "project:src/server.ts",
  "project:src/agents/app-agent.ts",
  "package:agents@0.17.4/dist/index.js",
  "package:partyserver@0.5.8/dist/index.js",
  "package:@cloudflare/ai-chat@0.9.3/dist/index.js",
]);

const REVIEWED_PRIVILEGED_IMPORTERS = new Set([
  "project:src/server.ts",
  "project:src/agents/app-agent.ts",
  "package:agents@0.17.4/dist/index.js",
  "package:agents@0.17.4/dist/client-C7F0MaVz.js",
  "package:partyserver@0.5.8/dist/index.js",
  "package:@cloudflare/ai-chat@0.9.3/dist/index.js",
]);

export function productionModuleSecurityPlugin(projectDir: string): Plugin {
  const canonicalProjectDir = resolve(projectDir);
  return {
    name: "ghostbuild-production-module-security",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || importer.includes("\0")) {
        return null;
      }
      const resolvedModule = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolvedModule) {
        const violation = findRuntimeModuleImportViolation(
          importer,
          resolvedModule.id,
          canonicalProjectDir,
        );
        if (violation) {
          this.error(importViolationMessage(violation));
        }
      }
      return null;
    },
    transform(code, id) {
      const cleanId = id.split("?", 1)[0];
      if (!SOURCE_EXTENSION.test(cleanId) || cleanId.includes("\0")) {
        return null;
      }
      const identity = moduleIdentity(cleanId, canonicalProjectDir);
      const reviewedDigest = REVIEWED_PACKAGE_MODULE_SHA256.get(identity);
      if (reviewedDigest && sha256(code) !== reviewedDigest) {
        this.error(
          `Reviewed production module ${identity} no longer matches its exact security baseline.`,
        );
      }
      const securedCode = applyReviewedModulePatch(identity, code);
      const allowed =
        REVIEWED_MODULE_CAPABILITIES.get(identity) ??
        new Set<RuntimeCapability>();
      const violations = findRuntimeModuleSecurityViolations(
        securedCode,
      ).filter((violation) => !allowed.has(violation.capability));
      if (violations.length > 0) {
        const first = violations[0];
        this.error(
          `Production module ${identity} uses forbidden ${first.capability} capability at ` +
            `${first.line}:${first.column}. Generated application code and unreviewed dependencies ` +
            "must use the protected Ghostbuild binding broker.",
        );
      }
      return securedCode === code ? null : { code: securedCode, map: null };
    },
    moduleParsed(module) {
      for (const imported of [
        ...module.importedIds,
        ...module.dynamicallyImportedIds,
      ]) {
        const violation = findRuntimeModuleImportViolation(
          module.id,
          imported,
          canonicalProjectDir,
        );
        if (violation) {
          this.error(importViolationMessage(violation));
        }
      }
    },
  };
}

export function findRuntimeModuleImportViolation(
  importerId: string,
  importedId: string,
  projectDir: string,
): RuntimeModuleImportViolation | null {
  if (importerId.includes("\0") || importedId.includes("\0")) {
    return null;
  }
  const importer = moduleIdentity(cleanModuleId(importerId), projectDir);
  const imported = moduleIdentity(cleanModuleId(importedId), projectDir);
  if (
    !PRIVILEGED_RUNTIME_MODULES.has(imported) ||
    REVIEWED_PRIVILEGED_IMPORTERS.has(importer)
  ) {
    return null;
  }
  return { importer, imported };
}

function importViolationMessage(
  violation: RuntimeModuleImportViolation,
): string {
  return (
    `Production module ${violation.importer} may not import privileged runtime module ` +
    `${violation.imported}. Generated application code must use src/app-bindings.ts ` +
    "and public client adapters instead."
  );
}

function applyReviewedModulePatch(identity: string, source: string): string {
  if (identity !== "package:partyserver@0.5.8/dist/index.js") {
    return source;
  }
  const ambientImport =
    'import { DurableObject, env } from "cloudflare:workers";';
  const routeSignature =
    "async function routePartykitRequest(req, env$1 = env, options) {";
  if (
    source.split(ambientImport).length !== 2 ||
    source.split(routeSignature).length !== 2
  ) {
    throw new Error(
      "Reviewed partyserver ambient-environment patch no longer applies exactly.",
    );
  }
  return source
    .replace(
      ambientImport,
      'import { DurableObject } from "cloudflare:workers";',
    )
    .replace(
      routeSignature,
      "async function routePartykitRequest(req, env$1, options) {",
    );
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function findRuntimeModuleSecurityViolations(
  source: string,
): RuntimeModuleSecurityViolation[] {
  const file = ts.createSourceFile(
    "module.tsx",
    normalizeJavaScriptEscapes(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: RuntimeModuleSecurityViolation[] = [];
  const seen = new Set<string>();

  function add(node: ts.Node, capability: RuntimeCapability) {
    const start = node.getStart(file);
    const key = `${start}:${capability}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const position = file.getLineAndCharacterOfPosition(start);
    violations.push({
      capability,
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === AMBIENT_WORKERS_MODULE
    ) {
      add(node.moduleSpecifier, "ambient-workers-module");
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      node.moduleReference.expression.text === AMBIENT_WORKERS_MODULE
    ) {
      add(node.moduleReference.expression, "ambient-workers-module");
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!isStaticDynamicImport(node)) {
          add(node.expression, "dynamic-import");
        }
      } else {
        const called = dangerousCallee(node.expression);
        if (called && !(called === "require-call" && isStaticRequire(node))) {
          add(node.expression, called);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const constructed = dangerousCallee(node.expression);
      if (constructed === "function-constructor") {
        add(node.expression, constructed);
      }
    }
    if (
      ts.isStringLiteralLike(node) &&
      node.text === AMBIENT_WORKERS_MODULE &&
      !isReviewedModuleSpecifierNode(node)
    ) {
      add(node, "ambient-workers-module");
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return violations;
}

function isStaticRequire(node: ts.CallExpression): boolean {
  if (
    node.arguments.length !== 1 ||
    !ts.isStringLiteralLike(node.arguments[0])
  ) {
    return false;
  }
  return node.arguments[0].text !== AMBIENT_WORKERS_MODULE;
}

function isStaticDynamicImport(node: ts.CallExpression): boolean {
  return (
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text !== AMBIENT_WORKERS_MODULE
  );
}

function dangerousCallee(expression: ts.Expression): RuntimeCapability | null {
  if (ts.isIdentifier(expression)) {
    if (expression.text === "require") {
      return "require-call";
    }
    if (expression.text === "eval") {
      return "eval-call";
    }
    if (expression.text === "Function") {
      return "function-constructor";
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return dangerousProperty(expression.name.text);
  }
  if (ts.isElementAccessExpression(expression)) {
    return dangerousProperty(staticString(expression.argumentExpression));
  }
  return null;
}

function dangerousProperty(name: string | null): RuntimeCapability | null {
  if (name === "eval") {
    return "eval-call";
  }
  if (name === "Function") {
    return "function-constructor";
  }
  return null;
}

function staticString(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticString(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function isReviewedModuleSpecifierNode(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(parent) && parent.expression === node)
  );
}

function moduleIdentity(id: string, projectDir: string): string {
  const normalized = id.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const lastNodeModules = normalized.lastIndexOf(marker);
  if (lastNodeModules !== -1) {
    const packagePath = normalized.slice(lastNodeModules + marker.length);
    const parts = packagePath.split("/");
    const packageLength = parts[0]?.startsWith("@") ? 2 : 1;
    const packageName = parts.slice(0, packageLength).join("/");
    const packageFile = parts.slice(packageLength).join("/");
    const packageRoot =
      normalized.slice(0, lastNodeModules + marker.length) + packageName;
    let version = "unversioned";
    try {
      const metadata = JSON.parse(
        readFileSync(`${packageRoot}/package.json`, "utf8"),
      ) as { version?: unknown };
      if (
        typeof metadata.version === "string" &&
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)
      ) {
        version = metadata.version;
      }
    } catch {
      // Missing or malformed package metadata can never match a reviewed entry.
    }
    return `package:${packageName}@${version}/${packageFile}`;
  }
  const projectRelative = relative(projectDir, resolve(id))
    .split(sep)
    .join("/");
  return projectRelative.startsWith("../")
    ? `external:${normalized}`
    : `project:${projectRelative}`;
}

function cleanModuleId(id: string): string {
  return id.split(/[?#]/, 1)[0];
}

function normalizeJavaScriptEscapes(source: string): string {
  return source
    .replace(/\\\r?\n/g, "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}
