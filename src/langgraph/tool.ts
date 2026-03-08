import { DynamicStructuredTool } from "@langchain/core/tools";
import { logger } from '../utils';

export type ToolDictionary = Record<string, DynamicStructuredTool>;
export type ToolFactory = (debug?: boolean) => ToolDictionary;

export class Tools {
  private toolsSource: ToolDictionary | ToolFactory;
  private toolConfig: Record<string, string> = {};
  private filteredToolNames?: string[];

  constructor(
    toolsSource: ToolDictionary | ToolFactory,
    toolsConfig?: Record<string, string>,
    debug?: boolean,
    filteredToolNames?: string[]
  ) {
    this.toolsSource = toolsSource;
    if (toolsConfig) this.toolConfig = toolsConfig;
    this.filteredToolNames = filteredToolNames;
  }

  private getAllTools(debug?: boolean): ToolDictionary {
    if (typeof this.toolsSource === "function") {
      return this.toolsSource(debug);
    }
    return this.toolsSource;
  }

  public getToolByName(debug?: boolean): ToolDictionary {
    const allTools = this.getAllTools(debug);

    // If no filter is set, return all enhanced tools
    if (!this.filteredToolNames || this.filteredToolNames.length === 0) {
      return allTools;
    }

    // Filter tools to only include selected names
    const filteredTools: ToolDictionary = {};
    for (const name of this.filteredToolNames) {
      if (allTools[name]) {
        filteredTools[name] = allTools[name];
      }
    }

    // If no tools match, return all tools as fallback (Requirement 7.2)
    if (Object.keys(filteredTools).length === 0) {
      logger(true, '⚠️ [Tools.getToolByName] No tools matched filter, returning all tools as fallback');
      return allTools;
    }

    return filteredTools;
  }

  /**
   * Filter tools to only include specified names
   * Implements Requirement 7.2: Filter tool dictionary to only include selected tools
   * 
   * @param names - Array of tool names to include
   */
  public withFilter(names: string[]): Tools {
    return new Tools(this.toolsSource, this.toolConfig, undefined, [...names]);
  }

  /**
   * @deprecated Use withFilter(names) for immutable filtering.
   */
  public filterToNames(names: string[]): void {
    this.filteredToolNames = names;
  }

  /**
   * @deprecated Use withFilter([]) or original Tools instance for immutable filtering.
   * Clear any tool name filters
   */
  public clearFilter(): void {
    this.filteredToolNames = undefined;
  }

  get Config() {
    return this.toolConfig;
  }
}
