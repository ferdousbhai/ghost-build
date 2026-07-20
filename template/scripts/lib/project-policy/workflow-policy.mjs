import { parseDocument } from "yaml";

const stagingPattern = /\bstaging\b/i;
const localEnvPattern =
  /(?:^|\s)--env-file(?:[=\s]|$)|(?:^|[\s"'`])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars(?:\.[\w.-]+)?)(?=$|[\s"'`])/;
const forbiddenWorkflowPatterns = [
  { pattern: stagingPattern, reason: "target staging" },
  { pattern: /\bwrangler\s+dev\b/, reason: "start Wrangler dev" },
  { pattern: /\bvite\s+(?:--host|dev)\b/, reason: "start Vite dev" },
  {
    pattern: /\b(?:pnpm|npm)\s+(?:run\s+)?(?:dev|start|preview)\b/,
    reason: "start a local package script",
  },
  { pattern: localEnvPattern, reason: "load local env files" },
];

export function findMissingCommandSteps(command, label, steps) {
  if (typeof command !== "string") {
    return [`${label} must be configured.`];
  }
  const errors = [];
  let cursor = -1;
  for (const step of steps) {
    const index = command.indexOf(step, cursor + 1);
    if (index === -1) {
      errors.push(`${label} must run ${JSON.stringify(step)} in order.`);
    } else {
      cursor = index;
    }
  }
  return errors;
}

export function findWorkflowSafetyErrors(content, label) {
  const parsed = parseYamlObject(content, label);
  if (!parsed.value) {
    return parsed.errors;
  }
  return [
    ...parsed.errors,
    ...findActionPinErrors(parsed.value, label),
    ...findForbiddenWorkflowRunErrors(parsed.value, label),
  ];
}

export function findCompositeActionSafetyErrors(content, label) {
  const parsed = parseYamlObject(content, label);
  if (!parsed.value) {
    return parsed.errors;
  }
  return [...parsed.errors, ...findActionPinErrors(parsed.value, label)];
}

export function findProductionDeployWorkflowErrors(content, label) {
  const parsed = parseYamlObject(content, label);
  if (!parsed.value) {
    return parsed.errors;
  }
  const workflow = parsed.value;
  const errors = [...parsed.errors];
  requireValue(errors, `${label} name`, workflow.name, "Production Deploy");
  requireWorkflowDispatch(errors, workflow, label);
  const push = isRecord(workflow.on) ? workflow.on.push : undefined;
  const branches =
    isRecord(push) && Array.isArray(push.branches) ? push.branches : [];
  if (!branches.includes("main")) {
    errors.push(`${label} must run for pushes to main.`);
  }

  const job = workflowJob(workflow, "deploy");
  if (!job) {
    errors.push(`${label} must define jobs.deploy.`);
    return errors;
  }
  requireValue(
    errors,
    `${label} jobs.deploy.if`,
    job.if,
    "github.repository == 'ferdousbhai/ghostbuild' && github.ref == 'refs/heads/main'",
  );
  const environmentName = isRecord(job.environment)
    ? job.environment.name
    : job.environment;
  requireValue(
    errors,
    `${label} jobs.deploy.environment.name`,
    environmentName,
    "production",
  );

  const steps = workflowJobSteps(job);
  const specifications = [
    runStep("pnpm run validate"),
    runStep("git diff --exit-code"),
    runStep("node scripts/deploy-production.mjs --check", {
      CLOUDFLARE_OAUTH_CLIENT_ID: "${{ vars.CLOUDFLARE_OAUTH_CLIENT_ID }}",
    }),
    runStep("pnpm run provision:production", {
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    }),
    runStep("pnpm run verify:production-config"),
    runStep("pnpm run d1:bookmark:production", {
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    }),
    runStep("pnpm run d1:migrations:apply:production", {
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    }),
    {
      description: "the Cloudflare Wrangler deploy action",
      matches: (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("cloudflare/wrangler-action@"),
      validate: (step, path) => {
        requireValue(
          errors,
          `${path}.with.apiToken`,
          isRecord(step.with) ? step.with.apiToken : undefined,
          "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        );
        requireValue(
          errors,
          `${path}.with.accountId`,
          isRecord(step.with) ? step.with.accountId : undefined,
          "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
        );
        requireValue(
          errors,
          `${path}.with.packageManager`,
          isRecord(step.with) ? step.with.packageManager : undefined,
          "pnpm",
        );
        requireValue(
          errors,
          `${path}.with.command`,
          isRecord(step.with) ? normalizedScalar(step.with.command) : undefined,
          "deploy --var COMMIT_SHA:${{ github.sha }} --var CLOUDFLARE_OAUTH_CLIENT_ID:${{ vars.CLOUDFLARE_OAUTH_CLIENT_ID }}",
        );
      },
    },
    runStep("node scripts/verify-live-deployment.mjs local", {
      EXPECTED_SHA: "${{ github.sha }}",
    }),
    runStep("node scripts/verify-live-deployment.mjs global", {
      EXPECTED_SHA: "${{ github.sha }}",
    }),
  ];
  requireOrderedWorkflowSteps(
    errors,
    steps,
    `${label} jobs.deploy`,
    specifications,
  );
  return errors;
}

export function findCiWorkflowErrors(content, label) {
  const parsed = parseYamlObject(content, label);
  if (!parsed.value) {
    return parsed.errors;
  }
  const errors = [...parsed.errors];
  requireWorkflowDispatch(errors, parsed.value, label);
  const steps = allWorkflowSteps(parsed.value);
  if (!steps.some((entry) => stepRuns(entry.step, "pnpm run validate"))) {
    errors.push(`${label} must run "pnpm run validate" in a job step.`);
  }
  if (!steps.some((entry) => stepRuns(entry.step, "git diff --exit-code"))) {
    errors.push(
      `${label} must verify tracked generated files with "git diff --exit-code".`,
    );
  }
  return errors;
}

export function findSystemPromptsReleaseWorkflowErrors(content, label) {
  const parsed = parseYamlObject(content, label);
  if (!parsed.value) {
    return parsed.errors;
  }
  const workflow = parsed.value;
  const errors = [...parsed.errors];
  requireValue(
    errors,
    `${label} name`,
    workflow.name,
    "Create System Prompts Release",
  );
  requireWorkflowDispatch(errors, workflow, label);
  requireValue(
    errors,
    `${label} permissions.contents`,
    isRecord(workflow.permissions) ? workflow.permissions.contents : undefined,
    "read",
  );
  const concurrency = isRecord(workflow.concurrency)
    ? workflow.concurrency
    : undefined;
  requireValue(
    errors,
    `${label} concurrency.group`,
    concurrency?.group,
    "system-prompts-release",
  );
  requireValue(
    errors,
    `${label} concurrency.cancel-in-progress`,
    concurrency?.["cancel-in-progress"],
    false,
  );
  for (const jobName of ["build", "release"]) {
    const job = workflowJob(workflow, jobName);
    if (!job) {
      errors.push(`${label} must define jobs.${jobName}.`);
      continue;
    }
    requireValue(
      errors,
      `${label} jobs.${jobName}.if`,
      job.if,
      "github.repository == 'ferdousbhai/ghostbuild' && github.ref == 'refs/heads/main'",
    );
  }

  const releaseJob = workflowJob(workflow, "release");
  if (releaseJob) {
    requireValue(
      errors,
      `${label} jobs.release.needs`,
      releaseJob.needs,
      "build",
    );
    requireValue(
      errors,
      `${label} jobs.release.permissions.contents`,
      isRecord(releaseJob.permissions)
        ? releaseJob.permissions.contents
        : undefined,
      "write",
    );
    requireOrderedWorkflowSteps(
      errors,
      workflowJobSteps(releaseJob),
      `${label} jobs.release`,
      [
        {
          description: "the pinned checkout action",
          matches: (step) =>
            typeof step.uses === "string" &&
            step.uses.startsWith("actions/checkout@"),
          validate: (step, path) => {
            requireValue(
              errors,
              `${path}.with.fetch-depth`,
              isRecord(step.with) ? step.with["fetch-depth"] : undefined,
              0,
            );
            requireValue(
              errors,
              `${path}.with.persist-credentials`,
              isRecord(step.with)
                ? step.with["persist-credentials"]
                : undefined,
              false,
            );
          },
        },
        {
          description: "the pinned artifact download action",
          matches: (step) =>
            typeof step.uses === "string" &&
            step.uses.startsWith("actions/download-artifact@"),
          validate: (step, path) => {
            requireValue(
              errors,
              `${path}.with.name`,
              isRecord(step.with) ? step.with.name : undefined,
              "ghostbuild-system-prompts",
            );
            requireValue(
              errors,
              `${path}.with.path`,
              isRecord(step.with) ? step.with.path : undefined,
              ".",
            );
          },
        },
        runStep("node scripts/create-system-prompts-release.mjs", {
          GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
          GITHUB_SHA: "${{ github.sha }}",
        }),
      ],
    );
  }
  return errors;
}

export function findMissingProvisionScriptPatternErrors(
  content,
  label,
  requiredPatterns,
) {
  return requiredPatterns
    .filter(({ pattern }) => !pattern.test(content))
    .map(({ description }) => `${label} must ${description}.`);
}

export function workflowPathsFromDirectoryEntries(entries) {
  return entries
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => `.github/workflows/${entry}`)
    .sort();
}

export function startsLocalDevServer(content) {
  return /\bwrangler\s+dev\b|\bvite\s+(?:--host|dev)\b/.test(content);
}

export function targetsStaging(...values) {
  return values.some((value) => stagingPattern.test(value));
}

export function loadsLocalEnvFiles(content) {
  return localEnvPattern.test(content);
}

function parseYamlObject(content, label) {
  const document = parseDocument(content, { uniqueKeys: true });
  const errors = document.errors.map(
    (error) => `${label} must be unambiguous YAML: ${error.message}`,
  );
  if (errors.length > 0) {
    return { value: null, errors };
  }
  try {
    const value = document.toJS();
    if (!isRecord(value)) {
      errors.push(`${label} must contain a top-level mapping.`);
      return { value: null, errors };
    }
    return { value, errors };
  } catch (error) {
    errors.push(
      `${label} must be valid YAML: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return { value: null, errors };
  }
}

function findActionPinErrors(root, label) {
  return actionReferences(root).flatMap(({ path, uses }) => {
    if (uses.startsWith("./")) {
      return [];
    }
    const separator = uses.lastIndexOf("@");
    const revision = separator === -1 ? "" : uses.slice(separator + 1);
    return /^[a-f0-9]{40}$/.test(revision)
      ? []
      : [
          `${label} ${path} must pin external action ${JSON.stringify(uses)} to a full commit SHA.`,
        ];
  });
}

function actionReferences(root) {
  const references = [];
  if (isRecord(root.jobs)) {
    for (const [jobName, jobValue] of Object.entries(root.jobs)) {
      if (!isRecord(jobValue)) {
        continue;
      }
      if (typeof jobValue.uses === "string") {
        references.push({ path: `jobs.${jobName}.uses`, uses: jobValue.uses });
      }
      for (const [index, step] of workflowJobSteps(jobValue).entries()) {
        if (typeof step.uses === "string") {
          references.push({
            path: `jobs.${jobName}.steps[${index}].uses`,
            uses: step.uses,
          });
        }
      }
    }
  }
  if (isRecord(root.runs) && Array.isArray(root.runs.steps)) {
    root.runs.steps.forEach((step, index) => {
      if (isRecord(step) && typeof step.uses === "string") {
        references.push({ path: `runs.steps[${index}].uses`, uses: step.uses });
      }
    });
  }
  return references;
}

function findForbiddenWorkflowRunErrors(workflow, label) {
  const errors = [];
  for (const { path, step } of allWorkflowSteps(workflow)) {
    if (typeof step.run !== "string") {
      continue;
    }
    const reasons = new Set();
    for (const command of meaningfulRunLines(step.run)) {
      for (const { pattern, reason } of forbiddenWorkflowPatterns) {
        if (pattern.test(command)) {
          reasons.add(reason);
        }
      }
    }
    for (const reason of reasons) {
      errors.push(`${label} ${path}.run must not ${reason}.`);
    }
  }
  return errors;
}

function allWorkflowSteps(workflow) {
  if (!isRecord(workflow.jobs)) {
    return [];
  }
  return Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
    isRecord(job)
      ? workflowJobSteps(job).map((step, index) => ({
          path: `jobs.${jobName}.steps[${index}]`,
          step,
        }))
      : [],
  );
}

function workflowJob(workflow, name) {
  const value = isRecord(workflow.jobs) ? workflow.jobs[name] : undefined;
  return isRecord(value) ? value : null;
}

function workflowJobSteps(job) {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}

function requireWorkflowDispatch(errors, workflow, label) {
  const triggers = isRecord(workflow.on) ? workflow.on : undefined;
  const dispatch = triggers?.workflow_dispatch;
  if (!triggers || !Object.hasOwn(triggers, "workflow_dispatch")) {
    errors.push(`${label} must enable workflow_dispatch.`);
  } else if (dispatch !== null && !isRecord(dispatch)) {
    errors.push(`${label} workflow_dispatch must be a mapping or empty.`);
  }
}

function runStep(command, env = undefined) {
  return {
    description: JSON.stringify(command),
    matches: (step) => stepRuns(step, command),
    validate: env
      ? (step, path, errors) => {
          for (const [name, value] of Object.entries(env)) {
            requireValue(
              errors,
              `${path}.env.${name}`,
              isRecord(step.env) ? step.env[name] : undefined,
              value,
            );
          }
        }
      : undefined,
  };
}

function requireOrderedWorkflowSteps(errors, steps, label, specifications) {
  let cursor = -1;
  for (const specification of specifications) {
    const index = steps.findIndex(
      (step, stepIndex) => stepIndex > cursor && specification.matches(step),
    );
    if (index === -1) {
      errors.push(
        `${label} must include ${specification.description} after the preceding required step.`,
      );
      continue;
    }
    cursor = index;
    specification.validate?.(steps[index], `${label}.steps[${index}]`, errors);
  }
}

function stepRuns(step, command) {
  return (
    typeof step.run === "string" &&
    meaningfulRunLines(step.run).includes(command)
  );
}

function meaningfulRunLines(run) {
  return run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function normalizedScalar(value) {
  return typeof value === "string" ? value.trim() : value;
}

function requireValue(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
