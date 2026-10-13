import { seedNow } from '../src/lib/seed';

seedNow()
  .then((r) => {
    console.log(r.seeded ? 'database seeded' : 'database already contains data — skipped');
    process.exit(0);
  })
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  });
