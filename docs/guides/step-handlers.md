# Write a step handler

A handler is a function from your project that an `auto` step runs. Use one when a step needs logic that no built-in adapter covers: a calculation, a check, a call to your own code. At the end of this guide you have a handler that reads its input and its settings, and you know the three ways it can end: return a result, fail, or stop the run.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one.

## 1. Write the handler

Create `registry.mjs` beside `workflow.yaml`. The file's default export has a `handlers` map. Each handler has an `id` and an `execute` function:

```javascript
export default {
  handlers: {
    order_total: {
      id: 'order_total',
      async execute(inputs, context) {
        const quantity = inputs.params.quantity;
        const unitPrice = context.config.unit_price;
        if (typeof quantity !== 'number' || quantity <= 0) {
          throw new Error(`quantity must be a positive number, got ${JSON.stringify(quantity)}`);
        }
        if (quantity > 1000) {
          return { abort: { message: 'Orders over 1000 units are quoted by hand.' } };
        }
        return { data: { total: quantity * unitPrice } };
      },
    },
  },
};
```

`execute` receives two things:

| Argument             | Holds                                              |
| -------------------- | -------------------------------------------------- |
| `inputs.params`      | The step's input, built by the step's `input_map`. |
| `context.config`     | The step's `config` block from the workflow file.  |
| `context.run_params` | The parameters the run was started with.           |
| `context.resources`  | The outputs of earlier steps, by step name.        |
| `context.run_id`     | The ID of the run.                                 |

## 2. Point the workflow at it

Name the file with `extensions` at the top of the workflow, and name the handler on the step:

```yaml
id: price
name: Price an order
version: 1
extensions: ./registry.mjs

params_schema:
  type: object
  additionalProperties: false
  required: [quantity]
  properties:
    quantity:
      type: number

steps:
  total:
    description: Work out the order total.
    execution: auto
    handler: order_total
    config:
      unit_price: 12.5
    input_map:
      quantity: run.params.quantity

  confirm:
    description: Say whether the total looks right.
    execution: agent
    depends_on: [total]
    prompt: 'The total is {{ context.resources.total.total }}. Does that look right?'
    input_schema:
      type: object
      additionalProperties: false
      required: [ok]
      properties:
        ok:
          type: boolean
```

The `handler` value must match a key in the `handlers` map.

## 3. Check and register

Check the file:

```bash
realm workflow validate ./
```

It prints:

```text
Valid: price v1 (2 steps)
Extensions: ./registry.mjs (adapters: 0, handlers: 1, processors: 0)
```

Notice the `Extensions` line. It confirms that Realm loaded your file and found one handler. Then register:

```bash
realm workflow register ./
```

## 4. Run it

Start a run with a quantity of 4, with whichever driver you use. The engine runs `total` in the first call, and the next step's prompt shows the result:

```text
Step 'total' completed. 1 step(s) now available.

The total is 50. Does that look right?
```

The record keeps the handler's input and output:

```text
  1. total                  success   1ms   hash: b2da9bae
     Input:  {"quantity":4}
     Resolved: {"quantity":4}
     Output: {"total":50}
```

## The three ways a handler ends

**Return `{ data: … }` when the work is done.** The object becomes the step's output. Later steps read it as `context.resources.<step>`. Return data for every outcome the workflow should deal with, including "nothing found".

**Throw an error when the step cannot do its work.** The step fails. With a quantity of -1:

```text
Step 'total' failed. Run is terminated.
ENGINE_HANDLER_FAILED: Handler 'order_total' threw: quantity must be a positive number, got -1
```

The run ends as `failed`, unless the workflow has a step that handles the failure. See [Handle failure](handle-failure.md).

**Return `{ abort: { message } }` when the run should stop on purpose.** This is for a condition you expected, where carrying on makes no sense. With a quantity of 5000:

```text
Phase: aborted
Sealed by: handler_abort (total)
Cause: Handler 'total' aborted the run: Orders over 1000 units are quoted by hand.
```

The run ends as `aborted`, not `failed`, and every later step is skipped.

## If you see something else

- **`Step 'total' is blocked: its handler 'order_totl' is not registered in this runner.`** The `handler` name on the step does not match a key in your `handlers` map. `realm workflow validate` does not catch this; it shows up when the step runs. The run is not ended: correct the name, register again, and the step can run.
- **`Handler step 'total' aborted the run: undefined`** Your handler returned `abort` without a `message`. Use `{ abort: { message: '…' } }`.

## See also

- [Handlers reference](../reference/handlers.md) covers the full interface and the built-in handlers.
- [Project extensions](../reference/project-extensions.md) covers the `extensions` file, including adapters and TypeScript.
- [Test a workflow](test-a-workflow.md)
