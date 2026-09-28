/**
 * Vendored HOST UI CONTRACT for broke's JSX components (BRK-024).
 *
 * Purpose: the CI type check must verify components against REAL host prop
 * shapes - never against `any` fallbacks that let typos pass silently.
 * This file pins the shapes the components actually consume, hand-vendored
 * from AiderDesk v0.80.0 / @aiderdesk/extensions 0.31.
 * Minimum supported host: AiderDesk 0.84. That is the floor because
 * `/broke diff` consumes TaskContext.getUpdatedFileDiff, which the HOST added in
 * 0.84 (verified in packages/common/src/extensions.ts at tag v0.84.0) - the
 * first PUBLISHED SDK exposing it is 0.34.0, one minor after the 0.33.0 that
 * ships with 0.84, so the npm tarball is NOT a reliable witness for what a
 * host version implements. Prove every API's runtime availability from the host
 * source at the floor tag; the tarball only bounds the compile surface.
 *
 * Verified consumed props against @aiderdesk/extensions 0.32.1 and
 * @aiderdesk/extensions 0.33.0 (checked against these hotovo/aider-desk source
 * commits), and re-verified against @aiderdesk/extensions 0.35.0:
 * - 0.32.1: d671c96a5b744d1215b4b9f2938f3bfa171802ea
 * - 0.33.0: ef09179b705eed5acb04b313c9acc5e39e7314f4
 * 0.35.0 was verified against a HOST SOURCE CHECKOUT, AiderDesk v0.85.0 at
 * commit 12d38d8e52543146e83e0dc44ef6439ba8aee099:
 * - Checkbox, Input and Button are unchanged since the 0.32.1 baseline;
 * - Select gained an optional `notFoundLabel?` (additive, not consumed here);
 * - Tooltip was reimplemented internally in 0.84 for rendering performance
 *   (one global host instead of a Radix provider per instance). Its exported
 *   prop signature - content, children, side, align, delayDuration, maxWidth
 *   - is unchanged, so the shape vendored below still holds.
 * So the shapes below are current: only the version reference was stale.
 * One capability degrades on a 0.84 host: the 'task-message-bar-menu'
 * placement does not exist there (it lands in 0.85), so the opt-in message
 * menu simply does not render - it is off by default for that reason too.
 * Sources: src/renderer/src/components/{common/{Button,Checkbox,Input,Select},ui/Tooltip}.tsx
 * and src/renderer/src/contexts/ExtensionsContext.tsx (direct UI registry).
 * Tooltip takes content (not label); Button requires children, not label.
 * These corrections apply to both verified versions. When a real AiderDesk
 * checkout is present, the validator prefers its live repo types.
 * Source: https://github.com/hotovo/aider-desk/tree/ef09179b705eed5acb04b313c9acc5e39e7314f4
 *
 * Re-vendor when bumping the minimum supported AiderDesk version.
 */
import * as React from 'react';

/** Minimal task header shape (currently unused by broke's components - kept structural, never `any`). */
export interface TaskData {
  id: string;
  provider?: string;
  model?: string;
  mainModel?: string;
}

export interface AgentProfile {
  provider: string;
  model: string;
}

export interface Model {
  id: string;
  providerId: string;
  name?: string;
  /** Input price per single token, when the registry carries one. */
  inputCostPerToken?: number;
}

export interface ProviderProfile {
  id: string;
  name?: string;
}

/** Message content arrives as string or text-part arrays; extensions narrow with manual type checks. */
export type Message = {
  id?: string;
  role?: string;
  content?: unknown;
} & Record<string, unknown>;

export type ApplicationAPI = Record<string, (...args: unknown[]) => unknown>;

/** `executeExtensionAction(action, ...args)` - fire a host UI action. */
export type ExecuteExtensionAction = (action: string, ...args: unknown[]) => Promise<unknown>;

/** Host UI primitives actually consumed by broke's components. */
export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface InputProps {
  label?: string;
  type?: string;
  min?: string;
  max?: string;
  defaultValue?: string;
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

export interface TooltipProps {
  content?: React.ReactNode;
  children?: React.ReactNode;
}

export interface ButtonProps {
  children?: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** Component registry the host injects as `ui` - used components carry real prop shapes. */
export interface UIComponents {
  Checkbox: React.ComponentType<CheckboxProps>;
  Input: React.ComponentType<InputProps>;
  Select: React.ComponentType<SelectProps>;
  Tooltip: React.ComponentType<TooltipProps>;
  Button: React.ComponentType<ButtonProps>;
}

/** Host icons registry: `icons.<group>.<name>` -> React node. */
export type IconsRegistry = Record<string, Record<string, React.ReactNode>>;

/** Props of a config (settings dialog) extension component. */
export interface ConfigComponentProps {
  extensionId: string;
  /**
   * The extension's own settings blob - the host stores it opaquely and the
   * Zod ConfigSchema (extension side) is its real contract, so it stays
   * value-typed (`any`) instead of a `Record<string, unknown>` that breaks
   * idiomatic JSX spreads. Not a host-owned shape.
   */
  config: Record<string, any> | null;
  updateConfig: (newConfig: Record<string, any>) => void;
  executeExtensionAction: ExecuteExtensionAction;
  ui: UIComponents;
  icons?: IconsRegistry;
  models?: Model[];
  providers?: unknown[];
  projectDir?: string;
  task?: TaskData;
  agentProfile?: AgentProfile;
  api?: ApplicationAPI;
}

/** Props of a task-status UI extension component (the badge). */
export interface UIComponentProps {
  /**
   * The extension's own payload from getUIExtensionData - the SHAPE is
   * defined by the extension, not by the host, so it is deliberately
   * untyped here (a vendored mirror of it would drift every release).
   * This is not a host prop - it is the component's own data contract.
   */
  data: any;
  executeExtensionAction: ExecuteExtensionAction;
  ui?: UIComponents;
  icons?: IconsRegistry;
  projectDir?: string;
  task?: TaskData;
  agentProfile?: AgentProfile;
  models?: Model[];
  providers?: unknown[];
  api?: ApplicationAPI;
  taskId?: string;
  mode?: string;
  message?: Message & Record<string, unknown>;
}
