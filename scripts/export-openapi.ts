import { app } from '../src/app.ts';
import { closeDb } from '../src/db/client.ts';
import { closeRedis } from '../src/lib/redis.ts';

const path = 'postman/specs/openapi.json';
try {
  const response = await app.request('/v1/openapi.json');
  if (!response.ok) throw new Error('OpenAPI generation failed');
  const generated = JSON.stringify(await response.json(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const snapshot = Bun.file(path);
    if (!(await snapshot.exists())) {
      throw new Error(`OpenAPI snapshot ${path} is missing; run bun run docs:openapi`);
    }
    if (
      JSON.stringify(JSON.parse(await snapshot.text())) !== JSON.stringify(JSON.parse(generated))
    ) {
      throw new Error('OpenAPI snapshot is stale; run bun run docs:openapi');
    }
    console.log('OpenAPI snapshot matches current routes');
  } else {
    await Bun.write(path, generated);
    console.log(`Updated ${path}`);
  }
} finally {
  closeRedis();
  await closeDb();
}
