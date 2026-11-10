import { describe, expect, it } from "vitest";
import { goalAsksForChange } from "./read-only.js";

describe("goalAsksForChange — sign-in verbs (#810)", () => {
  it.each([
    "Sign in with alice@example.com and password x",
    "Log in as alice@example.com",
    "Login with the demo account",
    "Authenticate with the test credentials",
  ])("%s asks for a change", (goal) => {
    expect(goalAsksForChange(goal)).toBe(true);
  });

  it.each([
    "How do I sign in?",
    "How can I log in to this site?",
    "Find out how to authenticate",
    "Find out what the login page asks for",
    "What happens if I log in with the wrong password?",
    "Find out which email address this profile is signed in with.",
  ])("%s stays read-only", (goal) => {
    expect(goalAsksForChange(goal)).toBe(false);
  });
});
