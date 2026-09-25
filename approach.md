> **Historical design note (2026-09-25).** This is the original design for jevitate as an automation
> platform that performs typed site Actions for a user from a queue. Jevitate became a testing tool
> instead, and its parts were superseded: Actions by promoted **Journeys** (typed parameters,
> MCP `run_journey`, trust-gated sources), the command queue by the **mission queue**
> (`jevitate mission run`), and approvals by the inbox/`jevitate ui` flow and promotion gates. The
> ActionRunner, site-sdk, example-network integration and SQLite command/event layer were removed.
> What carried over: the Screenplay layer (`@jevitate/screenplay`), site policies with human-like
> pacing, throttles, budgets and quiet hours (now enforced on Journey runs), and the example site.

Yes. A Screenplay-inspired model fits this system well—especially if we adapt it for durable production automation instead of copying a UI-testing framework literally.

The useful hierarchy is:

```text
Workflow
  -> Task
      -> Action
          -> Interaction
              -> Playwright
      -> Question
```

* **Workflow:** Business sequence, such as processing an inbox.
* **Task:** Reusable business operation, such as replying to a message.
* **Action:** Stable externally callable automation capability with typed parameters.
* **Interaction:** Low-level Playwright operation.
* **Question:** Read-only observation or assertion.
* **Actor:** Execution context containing the browser session and controlled abilities.

## Recommended architecture

```text
packages/
  screenplay/
    actor.ts
    abilities.ts
    action.ts
    task.ts
    question.ts
    runner.ts

  interactions/
    click.ts
    fill.ts
    navigate.ts
    wait-for.ts

  questions/
    current-recipient.ts
    message-visible.ts
    authenticated-user.ts

  shared-tasks/
    open-thread.ts
    compose-message.ts
    confirm-recipient.ts

site-integrations/
  example-network/
    actions/
      list-incoming.ts
      get-thread.ts
      reply-to-message.ts
    tasks/
      open-inbox.ts
      open-thread.ts
    questions/
      current-thread.ts
      sent-message.ts
    workflows/
      process-inbox.ts
    site.yaml
```

## Core types

Use a small framework owned by the application:

```ts
import { z } from "zod";

export interface Actor {
  readonly name: string;

  ability<T extends Ability>(
    ability: AbilityToken<T>,
  ): T;

  attemptsTo(
    ...activities: readonly Activity[]
  ): Promise<void>;

  asks<T>(
    question: Question<T>,
  ): Promise<T>;
}

export interface Ability {
  readonly kind: string;
}

export interface Activity {
  readonly description: string;

  performAs(actor: Actor): Promise<void>;
}

export interface Question<T> {
  readonly description: string;

  answeredBy(actor: Actor): Promise<T>;
}

export interface ActionDefinition<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> {
  readonly id: string;
  readonly version: string;
  readonly input: TInputSchema;
  readonly output: TOutputSchema;
  readonly risk: RiskClass;
  readonly throttleClass: string;

  execute(
    actor: Actor,
    input: z.output<TInputSchema>,
  ): Promise<z.output<TOutputSchema>>;
}
```

## Abilities

The actor receives narrowly scoped abilities:

```ts
export class BrowseTheWeb implements Ability {
  readonly kind = "browse-the-web";

  constructor(
    readonly page: Page,
    readonly origins: AllowedOrigins,
  ) {}
}

export class UseSiteSettings implements Ability {
  readonly kind = "use-site-settings";

  constructor(
    readonly settings: Readonly<SiteSettings>,
  ) {}
}

export class RecordEvidence implements Ability {
  readonly kind = "record-evidence";

  constructor(
    private readonly recorder: EvidenceRecorder,
  ) {}

  capture(request: EvidenceRequest): Promise<EvidenceReference> {
    return this.recorder.capture(request);
  }
}
```

Do not give the actor direct access to:

* SQLite
* Credentials
* Queue mutation
* Approval creation
* Model providers
* Arbitrary filesystem or network access

## Low-level interactions

Interactions wrap Playwright mechanics:

```ts
export const Click = {
  on(target: Target): Activity {
    return {
      description: `Click ${target.description}`,

      async performAs(actor) {
        const browser = actor.ability(BrowseTheWebToken);
        await target.resolve(browser.page).click();
      },
    };
  },
};

export const Enter = {
  text(value: string) {
    return {
      into(target: Target): Activity {
        return {
          description: `Enter text into ${target.description}`,

          async performAs(actor) {
            const browser = actor.ability(BrowseTheWebToken);
            await target.resolve(browser.page).fill(value);
          },
        };
      },
    };
  },
};
```

Targets hold semantic Playwright locators:

```ts
export const MessageEditor = Target.named(
  "message editor",
).locatedBy(page =>
  page.getByRole("textbox", {
    name: "Write a message",
  }),
);

export const SendButton = Target.named(
  "send button",
).locatedBy(page =>
  page.getByRole("button", {
    name: "Send",
    exact: true,
  }),
);
```

## Reusable tasks

Tasks compose interactions and questions:

```ts
export class ComposeMessage implements Activity {
  readonly description = "Compose a message";

  constructor(
    private readonly body: string,
  ) {}

  static with(body: string): ComposeMessage {
    return new ComposeMessage(body);
  }

  async performAs(actor: Actor): Promise<void> {
    await actor.attemptsTo(
      Enter.text(this.body).into(MessageEditor),
    );

    const actual = await actor.asks(
      ValueOf.target(MessageEditor),
    );

    if (actual !== this.body) {
      throw new PostconditionFailed(
        "Message editor does not contain expected content",
      );
    }
  }
}
```

Another site can reuse `ComposeMessage` if it supplies its own target through a site-specific screen model.

## High-level action

The action is the stable automation API exposed to queues and MCP:

```ts
const ReplyInput = z.object({
  threadId: z.string().min(1),
  recipient: IdentityReferenceSchema,
  body: z.string().min(1).max(2_000),
});

const ReplyOutput = z.object({
  receiptId: z.string(),
  sentAt: z.string().datetime(),
  contentHash: z.string(),
});

export const ReplyToMessage = defineAction({
  id: "message.reply",
  version: "1.0.0",
  input: ReplyInput,
  output: ReplyOutput,
  risk: "external_write",
  throttleClass: "write",

  async execute(actor, input) {
    await actor.attemptsTo(
      OpenThread.withId(input.threadId),
      VerifyRecipient.is(input.recipient),
      ComposeMessage.with(input.body),
    );

    const prepared = await PrepareCommit.for({
      action: "message.reply",
      bindings: input,
    }).answeredBy(actor);

    await actor.attemptsTo(
      RequireApproval.for(prepared),
      VerifyRecipient.is(input.recipient),
      Click.on(SendButton),
    );

    await actor.asks(
      SentMessage.exists({
        threadId: input.threadId,
        contentHash: prepared.contentHash,
      }),
    );

    return actor.asks(
      CurrentActionReceipt.value(),
    );
  },
});
```

## Serializable automation calls

The queue should store data—not instantiated TypeScript objects:

```json
{
  "action": "message.reply",
  "version": "1.0.0",
  "site": "example-network",
  "account": "primary",
  "arguments": {
    "threadId": "thread-123",
    "recipient": {
      "sourceId": "person-456",
      "displayName": "Jane Doe"
    },
    "body": "Thanks for reaching out."
  }
}
```

The registry resolves this into executable code:

```ts
const action = actionRegistry.resolve(
  command.site,
  command.action,
  command.version,
);

const input = action.input.parse(command.arguments);

const result = await action.execute(actor, input);

const output = action.output.parse(result);
```

This provides exactly the template behavior you described: the action implementation is the template, while queue parameters supply the variables.

## Composing larger workflows

A workflow can be TypeScript:

```ts
export const ProcessUnreadMessages = defineWorkflow({
  id: "inbox.process-unread",
  input: ProcessInboxInput,

  async execute(context, input) {
    const messages = await context.invoke("inbox.list", {
      unreadOnly: true,
      limit: input.limit,
    });

    for (const message of messages.items) {
      const classification = await context.modelTask(
        "message.classify",
        { message },
      );

      if (classification.requiresHuman) {
        await context.invoke("review.enqueue", {
          messageId: message.id,
          reason: classification.reason,
        });

        continue;
      }

      const draft = await context.modelTask("reply.draft", {
        message,
        contentProfile: input.contentProfile,
      });

      await context.invoke("message.reply", {
        threadId: message.threadId,
        recipient: message.sender,
        body: draft.body,
      });
    }
  },
});
```

Or a data-only workflow can compose registered actions:

```yaml
id: inbox.process-unread
version: 1.0.0

inputs:
  limit: { type: integer, maximum: 10 }
  content_profile: { type: string }

steps:
  - invoke:
      action: inbox.list
      with:
        unreadOnly: true
        limit: $inputs.limit
      save_as: messages

  - for_each:
      from: $messages.items
      max: 10
      as: message
      steps:
        - model_task:
            task: message.classify
            with:
              message: $message
            save_as: classification

        - branch:
            when: $classification.requiresHuman
            then:
              - invoke:
                  action: review.enqueue
                  with:
                    messageId: $message.id
            else:
              - invoke:
                  action: reply.draft
                  with:
                    message: $message
                    contentProfile: $inputs.content_profile
                  save_as: draft

              - invoke:
                  action: message.reply
                  with:
                    threadId: $message.threadId
                    recipient: $message.sender
                    body: $draft.body
```

This is where YAML remains valuable: it composes stable, tested actions without expressing raw browser interactions.

## Adapt Screenplay for production automation

The conventional Screenplay pattern needs several additions:

| Screenplay concept | Production addition                               |
| ------------------ | ------------------------------------------------- |
| Actor              | Account, browser profile, settings revision       |
| Ability            | Capability-limited service                        |
| Interaction        | Risk classification and tracing                   |
| Task               | Preconditions and postconditions                  |
| Question           | Typed observation with evidence                   |
| Action             | Input/output schema, throttle and approval policy |
| Workflow           | Checkpoints, bounded loops, resumability          |
| Assertion          | Reconciliation for unknown outcomes               |

Every external-write action should support:

```ts
interface ExternalWriteAction<Input, Output> {
  prepare(
    actor: Actor,
    input: Input,
  ): Promise<PreparedCommit>;

  commit(
    actor: Actor,
    input: Input,
    approved: ApprovedCommit,
  ): Promise<Output>;

  reconcile(
    actor: Actor,
    input: Input,
  ): Promise<ReconciliationResult>;
}
```

That is more important than following the Screenplay pattern perfectly.

## Recommendation

Use three layers:

1. **Playwright interactions and questions** for low-level browser mechanics.
2. **TypeScript tasks and actions** for reusable, typed site capabilities.
3. **YAML workflows** only for composing registered actions and model tasks.

The LLM should normally generate or patch TypeScript actions and YAML compositions. Production MCP calls enqueue registered actions with validated parameters; they never expose raw Screenplay interactions or Playwright.

This gives you modular code without forcing every browser detail into YAML, while preserving a simple, serializable automation API.
