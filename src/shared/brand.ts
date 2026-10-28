// The project's name and home, used by the admin, emails and the setup wizard.

export const APP_NAME = "Shorthop";
export const REPO_URL = "https://github.com/jntegz/shorthop";
export const AUTHOR_NAME = "Jan Tegze";
export const AUTHOR_URL = "https://jantegze.com";
/** package.json's version, put in by Vite at build time. Scripts run without Vite see "dev". */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
