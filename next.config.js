/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // ESLintチェックを一時的に無効化
    ignoreDuringBuilds: true,
  },
  typescript: {
    // TypeScriptチェックを一時的に無効化
    ignoreBuildErrors: true,
  },
  distDir: '.next',
  swcMinify: true
}

module.exports = nextConfig 