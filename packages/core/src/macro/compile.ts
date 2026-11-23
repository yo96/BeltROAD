import { CompiledMacro, DesignSpec, SynthesisResult } from '../types.js';
import { compileRecipeMacroVariants } from './recipeMacro.js';
import { compileDirectInsertMacro } from './directInsertMacro.js';
import { compileBalancerMacro } from './balancerMacro.js';

export interface MacroVariantSet {
  id: string;
  variants: CompiledMacro[];
}

export function compileAllMacros(
  synth: SynthesisResult,
  spec: DesignSpec,
): MacroVariantSet[] {
  const compactMacros = spec.optimization?.compactMacros ?? true;
  const result: MacroVariantSet[] = [];
  for (const node of synth.nodes) {
    if (node.kind === 'recipe-macro') {
      result.push({
        id: node.id,
        variants: node.directInsert
          ? compileDirectInsertMacro(node, spec.pdk)
          : compileRecipeMacroVariants(node, spec.pdk, compactMacros),
      });
    } else if (node.kind === 'balancer-macro') {
      result.push({
        id: node.id,
        variants: [compileBalancerMacro(node, spec.customBalancers ?? [])],
      });
    }
  }
  return result;
}
