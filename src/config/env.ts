import { z } from 'zod';

/** Thrown when environment settings are missing or invalid. Never contains setting values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// An empty value in .env (for example `JIRA_EMAIL=`) means "not set".
const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

const withDefault = <T extends z.ZodType>(schema: z.ZodDefault<T>) =>
  z.preprocess(emptyToUndefined, schema);

const envSchema = z
  .object({
    NODE_ENV: withDefault(z.enum(['development', 'test', 'production']).default('development')),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535).default(3000)),
    LOG_LEVEL: withDefault(z.enum(['debug', 'info', 'warn', 'error']).default('info')),

    JIRA_BASE_URL: optional(z.url()),
    JIRA_EMAIL: optional(z.email()),
    JIRA_API_TOKEN: optional(z.string().min(1)),
    JIRA_PROJECT: withDefault(z.string().min(1).default('SHP')),
    JIRA_AC_FIELD: optional(z.string().min(1)),
    JIRA_ENABLE_RELEASE: withDefault(z.stringbool().default(false)),

    AI_PROVIDER: withDefault(z.enum(['gemini', 'fake']).default('fake')),
    AI_API_KEY: optional(z.string().min(1)),
    AI_MODEL: optional(z.string().min(1)),
    AI_FALLBACK_MODELS: optional(z.string().min(1)),
    AI_MAX_OUTPUT_TOKENS: withDefault(z.coerce.number().int().min(256).max(65_536).default(8192)),

    GITHUB_TOKEN: optional(z.string().min(1)),
    GITHUB_REPOS: optional(z.string().min(1)),

    DATABASE_URL: optional(z.url()),
    DB_RETENTION_DAYS: withDefault(z.coerce.number().int().min(1).max(3650).default(90)),
  })
  .superRefine((env, ctx) => {
    const jira = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const;
    if (jira.some((key) => env[key] !== undefined)) {
      for (const key of jira) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when any other Jira connection setting is set',
          });
        }
      }
    }

    if (env.AI_PROVIDER === 'gemini') {
      for (const key of ['AI_API_KEY', 'AI_MODEL'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when AI_PROVIDER is "gemini"',
          });
        }
      }
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  jira?: {
    baseUrl: string;
    email: string;
    apiToken: string;
    project: string;
    acceptanceCriteriaField?: string;
    /** Release (Fix version) input. Off until the team confirms Fix versions are used. */
    enableRelease: boolean;
  };
  ai: {
    provider: 'gemini' | 'fake';
    apiKey?: string;
    model?: string;
    /** Models tried in order when the main model runs out of daily quota. */
    fallbackModels: string[];
    /** Hard cap for the length of every AI answer. */
    maxOutputTokens: number;
  };
  github?: {
    token: string;
    repos: string[];
  };
  databaseUrl?: string;
  /** Runs and cached results older than this many days are removed by `db purge`. */
  databaseRetentionDays: number;
}

/**
 * Reads and validates settings from environment variables.
 * Fails fast with a readable message that names each bad setting (never its value).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  const env = parsed.data;
  const config: AppConfig = {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseRetentionDays: env.DB_RETENTION_DAYS,
    ai: {
      provider: env.AI_PROVIDER,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      fallbackModels: (env.AI_FALLBACK_MODELS ?? '')
        .split(',')
        .map((model) => model.trim())
        .filter((model, index, all) => model !== '' && all.indexOf(model) === index)
        .filter((model) => model !== env.AI_MODEL),
    },
  };

  if (env.AI_API_KEY !== undefined) config.ai.apiKey = env.AI_API_KEY;
  if (env.AI_MODEL !== undefined) config.ai.model = env.AI_MODEL;
  if (env.DATABASE_URL !== undefined) config.databaseUrl = env.DATABASE_URL;

  if (env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    config.jira = {
      baseUrl: env.JIRA_BASE_URL.replace(/\/+$/, ''),
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      project: env.JIRA_PROJECT,
      enableRelease: env.JIRA_ENABLE_RELEASE,
      ...(env.JIRA_AC_FIELD !== undefined && { acceptanceCriteriaField: env.JIRA_AC_FIELD }),
    };
  }

  if (env.GITHUB_TOKEN) {
    config.github = {
      token: env.GITHUB_TOKEN,
      repos: (env.GITHUB_REPOS ?? '')
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean),
    };
  }

  return config;
}
