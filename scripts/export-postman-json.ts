import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

const KeyValueSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).transform(String),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
});

const AuthSchema = z.object({
  type: z.string(),
  credentials: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
});

const ScriptSchema = z.object({
  type: z.string(),
  language: z.string().optional(),
  code: z.string(),
});

const DefinitionYamlSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  order: z.number().optional(),
  auth: AuthSchema.optional(),
  variables: z.array(KeyValueSchema).optional(),
  scripts: z.array(ScriptSchema).optional(),
});

const RequestBodySchema = z.union([
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.enum(['json', 'text', 'xml', 'html', 'javascript']),
    content: z.string(),
  }),
  z.object({
    type: z.literal('file'),
    content: z.object({ src: z.string().optional() }),
  }),
  z.object({
    type: z.literal('urlencoded'),
    content: z.array(KeyValueSchema),
  }),
]);

const RequestYamlSchema = z.object({
  name: z.string().optional(),
  method: z.string(),
  url: z.string(),
  order: z.number().default(0),
  description: z.string().optional(),
  auth: AuthSchema.optional(),
  headers: z.array(KeyValueSchema).optional(),
  queryParams: z.array(KeyValueSchema).optional(),
  pathVariables: z.array(KeyValueSchema).optional(),
  body: RequestBodySchema.optional(),
  scripts: z.array(ScriptSchema).optional(),
});

const EnvYamlSchema = z.object({
  name: z.string(),
  values: z.array(
    z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).transform(String),
      enabled: z.boolean().default(true),
      type: z.string().default('default'),
      description: z.string().optional(),
    }),
  ),
});

function toV2Auth(
  auth: z.infer<typeof AuthSchema> | undefined,
): Record<string, unknown> | undefined {
  if (auth === undefined) return undefined;
  if (auth.type === 'noauth') return { type: 'noauth' };
  const creds = (auth.credentials ?? []).map((c) => ({
    key: c.key,
    value: c.value,
    type: 'string',
  }));
  return {
    type: auth.type,
    [auth.type]: creds,
  };
}

function toV2Events(
  scripts: readonly z.infer<typeof ScriptSchema>[] | undefined,
): Record<string, unknown>[] | undefined {
  if (scripts === undefined || scripts.length === 0) return undefined;
  return scripts.map((s) => ({
    listen: s.type.endsWith('beforeRequest') ? 'prerequest' : 'test',
    script: {
      type: s.language ?? 'text/javascript',
      exec: s.code.split('\n'),
    },
  }));
}

function toV2Body(
  body: z.infer<typeof RequestBodySchema> | undefined,
): Record<string, unknown> | undefined {
  if (body === undefined || body.type === 'none') return undefined;
  if (body.type === 'file') {
    return { mode: 'file', file: { src: body.content.src ?? '' } };
  }
  if (body.type === 'urlencoded') {
    return {
      mode: 'urlencoded',
      urlencoded: body.content.map((item) => ({
        key: item.key,
        value: item.value,
        type: 'text',
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      })),
    };
  }
  return {
    mode: 'raw',
    raw: body.content,
    options: {
      raw: { language: body.type },
    },
  };
}

function toV2Url(req: z.infer<typeof RequestYamlSchema>): Record<string, unknown> {
  const [withoutQuery = req.url] = req.url.split('?');
  let host: string[];
  let pathSegments: string[] = [];

  if (withoutQuery.startsWith('{{')) {
    const firstSlash = withoutQuery.indexOf('/');
    if (firstSlash === -1) {
      host = [withoutQuery];
    } else {
      host = [withoutQuery.slice(0, firstSlash)];
      pathSegments = withoutQuery
        .slice(firstSlash + 1)
        .split('/')
        .filter((seg) => seg.length > 0);
    }
  } else {
    host = [withoutQuery];
  }

  return {
    raw: req.url,
    host,
    ...(pathSegments.length > 0 ? { path: pathSegments } : {}),
    ...(req.queryParams !== undefined && req.queryParams.length > 0
      ? {
          query: req.queryParams.map((q) => ({
            key: q.key,
            value: q.value,
            ...(q.description !== undefined ? { description: q.description } : {}),
            ...(q.disabled !== undefined ? { disabled: q.disabled } : {}),
          })),
        }
      : {}),
    ...(req.pathVariables !== undefined && req.pathVariables.length > 0
      ? {
          variable: req.pathVariables.map((v) => ({
            key: v.key,
            value: v.value,
            ...(v.description !== undefined ? { description: v.description } : {}),
          })),
        }
      : {}),
  };
}

interface OrderedV2Item {
  readonly order: number;
  readonly name: string;
  readonly item: Record<string, unknown>;
}

async function readDefinition(dir: string): Promise<z.infer<typeof DefinitionYamlSchema>> {
  const defFile = Bun.file(join(dir, '.resources', 'definition.yaml'));
  if (!(await defFile.exists())) {
    return {};
  }
  const parsed: unknown = Bun.YAML.parse(await defFile.text());
  return DefinitionYamlSchema.parse(parsed);
}

async function buildFolderItems(dir: string): Promise<{
  readonly items: Record<string, unknown>[];
  readonly requestCount: number;
}> {
  const entries = readdirSync(dir);
  const ordered: OrderedV2Item[] = [];
  let requestCount = 0;

  for (const entry of entries) {
    if (entry === '.resources') continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const def = await readDefinition(fullPath);
      const child = await buildFolderItems(fullPath);
      requestCount += child.requestCount;
      const folderName = def.name ?? entry;
      const auth = toV2Auth(def.auth);
      const events = toV2Events(def.scripts);

      ordered.push({
        order: def.order ?? 0,
        name: folderName,
        item: {
          name: folderName,
          ...(def.description !== undefined ? { description: def.description } : {}),
          ...(auth !== undefined ? { auth } : {}),
          ...(events !== undefined ? { event: events } : {}),
          item: child.items,
        },
      });
    } else if (entry.endsWith('.request.yaml')) {
      const parsed: unknown = Bun.YAML.parse(await Bun.file(fullPath).text());
      const req = RequestYamlSchema.parse(parsed);
      const reqName = req.name ?? basename(entry, '.request.yaml');
      const auth = toV2Auth(req.auth);
      const body = toV2Body(req.body);
      const events = toV2Events(req.scripts);
      requestCount += 1;

      ordered.push({
        order: req.order,
        name: reqName,
        item: {
          name: reqName,
          ...(events !== undefined ? { event: events } : {}),
          request: {
            ...(auth !== undefined ? { auth } : {}),
            method: req.method,
            header: (req.headers ?? []).map((h) => ({
              key: h.key,
              value: h.value,
              type: 'text',
              ...(h.description !== undefined ? { description: h.description } : {}),
              ...(h.disabled !== undefined ? { disabled: h.disabled } : {}),
            })),
            ...(body !== undefined ? { body } : {}),
            url: toV2Url(req),
            ...(req.description !== undefined ? { description: req.description } : {}),
          },
          response: [],
        },
      });
    }
  }

  ordered.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return {
    items: ordered.map((entry) => entry.item),
    requestCount,
  };
}

const collectionRoot = 'postman/collections/Project 1 API';
const rootDef = await readDefinition(collectionRoot);
const { items, requestCount } = await buildFolderItems(collectionRoot);

const rootAuth = toV2Auth(rootDef.auth);
const rootEvents = toV2Events(rootDef.scripts);

const v2Collection: Record<string, unknown> = {
  info: {
    name: rootDef.name ?? 'Project 1 API',
    ...(rootDef.description !== undefined ? { description: rootDef.description } : {}),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  ...(rootAuth !== undefined ? { auth: rootAuth } : {}),
  ...(rootEvents !== undefined ? { event: rootEvents } : {}),
  ...(rootDef.variables !== undefined && rootDef.variables.length > 0
    ? {
        variable: rootDef.variables.map((v) => ({
          key: v.key,
          value: v.value,
          type: 'string',
          ...(v.description !== undefined ? { description: v.description } : {}),
        })),
      }
    : {}),
  item: items,
};

const envYaml: unknown = Bun.YAML.parse(
  await Bun.file('postman/environments/Local.environment.yaml').text(),
);
const parsedEnv = EnvYamlSchema.parse(envYaml);

const v2Env = {
  name: parsedEnv.name,
  values: parsedEnv.values.map((v) => ({
    key: v.key,
    // Always export secret variables empty so no credentials ever leak into shared JSON exports.
    value: v.type === 'secret' ? '' : v.value,
    type: v.type,
    enabled: v.enabled,
  })),
  _postman_variable_scope: 'environment',
};

const collectionOutPath = 'postman/exports/project-1-api.postman_collection.json';
const envOutPath = 'postman/exports/local.postman_environment.json';

const collectionJson = JSON.stringify(v2Collection, null, 2) + '\n';
const envJson = JSON.stringify(v2Env, null, 2) + '\n';

if (process.argv.includes('--check')) {
  for (const [outputPath, expected] of [
    [collectionOutPath, collectionJson],
    [envOutPath, envJson],
  ] as const) {
    const snapshot = Bun.file(outputPath);
    if (!(await snapshot.exists())) {
      throw new Error(`${outputPath} is missing; run bun run docs:postman`);
    }
    const current = (await snapshot.text()).replaceAll('\r\n', '\n');
    if (current !== expected) {
      throw new Error(`${outputPath} is stale; run bun run docs:postman`);
    }
  }
  console.log('Postman exports are up to date');
} else {
  await Bun.write(collectionOutPath, collectionJson);
  await Bun.write(envOutPath, envJson);
  console.log(
    `Exported ${requestCount} requests -> ${collectionOutPath} and ${parsedEnv.values.length} env vars -> ${envOutPath}`,
  );
}
