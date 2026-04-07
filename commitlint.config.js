module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [0],
    'header-max-length': [2, 'always', 100],
    'body-empty': [2, 'always'],
    'footer-empty': [2, 'always'],
    'no-co-authored-by': [2, 'always'],
  },
  plugins: [
    {
      rules: {
        'no-co-authored-by': ({ raw }) => {
          const hasCoAuthor = /^Co-Authored-By:/im.test(raw);
          return [!hasCoAuthor, 'commit message must not contain Co-Authored-By'];
        },
      },
    },
  ],
};
