import { Target } from "@doit/screenplay";

export const UsernameField = Target.named("username field").locatedBy((p) => p.getByLabel("Username"));
export const SignInButton = Target.named("sign in button").locatedBy((p) => p.getByRole("button", { name: "Sign in" }));
export const InboxHeading = Target.named("inbox heading").locatedBy((p) => p.getByRole("heading", { name: "Inbox" }));
export const ThreadItems = Target.named("thread items").locatedBy((p) => p.locator("li[data-thread-id]"));
export const ThreadMessages = Target.named("thread messages").locatedBy((p) => p.locator("li[data-message-id]"));
export const ThreadHeading = Target.named("thread heading").locatedBy((p) => p.getByRole("heading").first());
