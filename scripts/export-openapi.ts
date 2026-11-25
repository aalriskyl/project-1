import { app } from '../src/app.ts';
import { closeDb } from '../src/db/client.ts';

const path = 'postman/specs/openapi.json';
try {
  const response = await app.request('/v1/openapi.json');
  if (!response.ok) throw new Error('OpenAPI generation failed');
  const generated = JSON.stringify(await response.json(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (
      JSON.stringify(JSON.parse(await Bun.file(path).text())) !==
      JSON.stringify(JSON.parse(generated))
    )
      throw new Error('OpenAPI snapshot is stale; run bun run docs:openapi');
    console.log('OpenAPI snapshot matches current routes');
  } else {
    await Bun.write(path, generated);
    console.log(`Updated ${path}`);
  }
} finally {
  await closeDb();
}
