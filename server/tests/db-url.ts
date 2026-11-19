// CI sets REQUIRE_DB_TESTS=1 so a missing database fails the run instead of
// silently skipping every DB-backed suite.
export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL
  if (!url && process.env.REQUIRE_DB_TESTS === '1') throw new Error('REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set')
  return url
}
