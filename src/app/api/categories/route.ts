import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

/** Public category tree (database-driven, admin-extensible). */
export async function GET() {
  try {
    await bootstrap();
    const cats = await db.category.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, slug: true, name: true, parentId: true },
    });
    const roots = cats
      .filter((c) => c.parentId === null)
      .map((c) => ({ ...c, children: cats.filter((k) => k.parentId === c.id) }));
    return Response.json({ categories: roots }, {
      // Taxonomy changes rarely — cached at the edge for five minutes.
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (e) {
    console.error('categories error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load categories' }, { status: 500 });
  }
}
