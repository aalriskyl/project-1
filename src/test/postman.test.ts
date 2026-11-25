import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { app } from '@/app.ts';

const RequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  auth: z
    .object({
      type: z.string(),
      credentials: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    })
    .optional(),
  body: z.object({ type: z.string(), content: z.unknown() }).optional(),
});
const SpecSchema = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) });

describe('Postman contracts', () => {
  test('keeps the OpenAPI snapshot synchronized with the application', async () => {
    const generated: unknown = await (await app.request('/v1/openapi.json')).json();
    const saved: unknown = await Bun.file('postman/specs/openapi.json').json();
    expect(saved).toEqual(generated);
  });
  test('parses all YAML and maps every HTTP request to an existing operation', async () => {
    const spec = SpecSchema.parse(await Bun.file('postman/specs/openapi.json').json());
    const requests = new Map<string, z.infer<typeof RequestSchema>>();
    for await (const path of new Bun.Glob('**/*.yaml').scan('postman')) {
      const parsed: unknown = Bun.YAML.parse(await Bun.file(`postman/${path}`).text());
      if (!path.endsWith('.request.yaml')) continue;
      const request = RequestSchema.parse(parsed);
      requests.set(path.replaceAll('\\', '/'), request);
      if (request.url === '{{uploadUrl}}') {
        expect(request.method).toBe('PUT');
        expect(request.body?.type).toBe('file');
        continue;
      }
      const urlPath = request.url.replace('{{baseUrl}}', '').split('?')[0] ?? '';
      if (urlPath === '/v1/openapi.json') {
        expect(request.method).toBe('GET');
        expect((await app.request(urlPath)).status).toBe(200);
        continue;
      }
      const matches = Object.entries(spec.paths).some(([route, methods]) => {
        const pattern = route
          .split('/')
          .map((part) =>
            part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('/');
        return (
          methods[request.method.toLowerCase()] !== undefined &&
          new RegExp(`^${pattern}$`).test(urlPath)
        );
      });
      expect(matches, `${request.method} ${request.url}`).toBe(true);
      if (request.body?.type === 'json') {
        const content = z.string().parse(request.body.content);
        expect(() => JSON.parse(content.replace(/\{\{[^}]+\}\}/g, '0')), path).not.toThrow();
      }
    }
    const complete = requests.get(
      'collections/Project 1 API/Admin/Media/Complete Media Upload.request.yaml',
    );
    expect(complete?.url).toBe('{{baseUrl}}/v1/admin/media/{{uploadId}}/complete');
    const link = requests.get('collections/Project 1 API/Auth/Link Google Account.request.yaml');
    expect(link?.auth?.type).toBe('bearer');
    expect(link?.auth?.credentials).toEqual([{ key: 'token', value: '{{accessToken}}' }]);
  });
});
