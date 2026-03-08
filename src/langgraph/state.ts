import { MessagesAnnotation } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { PendingToolCall } from './types';
import { RAGDecision, RAGDocument } from '../types/rag.types';

/**
 * State for the FluidTools agent
 *
 * Uses LangGraph v1.0's MessagesAnnotation for proper message handling.
 * This is the recommended approach in LangGraph v1.0+
 *
 * MessagesAnnotation provides:
 * - Built-in message array with smart_message
 * - Proper TypeScript types
 * - Same behavior as Python's add_messages
 *
 * We extend it with maxToolCalls for recursion control and
 * pendingConfirmations for human-in-the-loop support.
 */
const MessagesState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // authToken: Annotation<string | undefined>(),
  maxToolCalls: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 10,
  }),
  /** Tools waiting for human confirmation */
  pendingConfirmations: Annotation<PendingToolCall[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  /** Whether the graph is paused waiting for confirmation */
  awaitingConfirmation: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),
  /** RAG decision from router node */
  ragDecision: Annotation<RAGDecision | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  /** Retrieved RAG documents */
  ragDocs: Annotation<RAGDocument[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  /** Formatted RAG context string */
  ragContext: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
});

export default MessagesState;
