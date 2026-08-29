/**
 * Vendored HOST UI CONTRACT for broke's JSX components (BRK-024).
 *
 * Purpose: the CI type check must verify components against REAL host prop
 * shapes - never against `any` fallbacks that let typos pass silently.
 * This file pins the shapes the components actually consume, hand-vendored
 * from AiderDesk v0.80.0 / @aiderdesk/extensions 0.31 (the version the
 * extension compiles against; see devDependencies). When a real AiderDesk
 * checkout is present (packages/common detected), the validator prefers the
 * live repo types over this file.
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
  label?: string;
  children?: React.ReactNode;
}

export interface ButtonProps {
  label?: string;
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
