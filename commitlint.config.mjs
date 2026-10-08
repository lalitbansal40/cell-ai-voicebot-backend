export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Room for task tags like "[P0-T0.7]".
    'header-max-length': [2, 'always', 120],
  },
};
