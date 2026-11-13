import i18n from "../i18n";
import en from "../locales/en/dictationChain.json";

// The rewrite chain's strings live in their own namespace so the fork never
// touches upstream's large translation files. Other UI languages fall back to
// English through i18next's fallbackLng.
export const DICTATION_CHAIN_NS = "dictationChain";

if (!i18n.hasResourceBundle("en", DICTATION_CHAIN_NS)) {
  i18n.addResourceBundle("en", DICTATION_CHAIN_NS, en, true, true);
}
