// gate-answers-door.ts — #627 W (§5.1): the `realm mcp` / `realm serve` side of the gate-answers
// setting. Correction 2 (4.1): the programs' words have ONE home, `@sensigo/realm-mcp`'s
// `bin-settings.ts` (its own `realm-mcp` bin reads them too); this file re-exports them, so its
// importers and cells are unchanged. Gap 2, unit (iv-b1): the failure-text lines too.
export {
  checkValueLine,
  DEV_MODE_ANSWER_WARNING,
  failureTextCheckLine,
  failureTextStartLine,
  formWaitBinRefusal,
  formWaitInertRefusal,
  formWaitNoFormsRefusal,
  gateAnswersBinRefusal,
  gateAnswersConnectLine,
  gateAnswersStartLine,
  offeredGivenToProgram,
  OFFERED_DEPRECATION_ID,
  readBinDoorSettings,
  type BinDoorFlags,
  type BinName,
} from '@sensigo/realm-mcp';
