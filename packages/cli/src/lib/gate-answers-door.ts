// gate-answers-door.ts — #627 W (§5.1): the `realm mcp` / `realm serve` side of the gate-answers
// setting. Correction 2 (4.1): the programs' words have ONE home, `@sensigo/realm-mcp`'s
// `bin-settings.ts` (its own `realm-mcp` bin reads them too); this file re-exports them, so its
// importers and cells are unchanged.
export {
  checkValueLine,
  DEV_MODE_ANSWER_WARNING,
  formWaitBinRefusal,
  formWaitInertRefusal,
  formWaitNoFormsRefusal,
  gateAnswersBinRefusal,
  gateAnswersStartLine,
  readBinDoorSettings,
  type BinDoorFlags,
  type BinName,
} from '@sensigo/realm-mcp';
