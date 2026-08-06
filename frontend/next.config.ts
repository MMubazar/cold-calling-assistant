import type { NextConfig } from 'next'

const config: NextConfig = {
  // This app is one of two packages in the repo; pin the root so Next does not
  // walk up and pick a lockfile from outside the project.
  outputFileTracingRoot: import.meta.dirname,
  // The frontend reads Postgres directly and proxies dial requests to the
  // backend call server, so nothing here is statically prerenderable.
  env: {
    BACKEND_URL: process.env.BACKEND_URL ?? 'http://127.0.0.1:8080',
  },
}

export default config
