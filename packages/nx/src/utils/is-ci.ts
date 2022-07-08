export function isCI() {
  return (
    process.env.CI === 'true' ||
    process.env.TF_BUILD === 'true' ||
    process.env.bamboo_planKey ||
    process.env.BUILDKITE === 'true' ||
    process.env.CIRCLECI === 'true' ||
    process.env.CIRRUS_CI === 'true' ||
    process.env.CODEBUILD_BUILD_ID ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.GITLAB_CI ||
    process.env.HEROKU_TEST_RUN_ID ||
    process.env.BUILD_ID ||
    process.env.BUILD_BUILDID ||
    process.env.TEAMCITY_VERSION ||
    process.env.TRAVIS === 'true'
  );
}
