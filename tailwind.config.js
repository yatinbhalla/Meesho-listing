/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/client/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        meesho: {
          pink:  '#f43397',
          light: '#fce7f3',
          dark:  '#9d174d',
        },
      },
    },
  },
  plugins: [],
};
