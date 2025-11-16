'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'status';
  content: string;
  stage?: 'planning' | 'executing' | 'summarizing';
  isStreaming?: boolean;
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const query = input.trim();
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: query,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    const statusMessages = new Map<string, ChatMessage>();

    try {
      const response = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: query }),
      });

      if (!response.ok) {
        throw new Error('Failed to execute goal');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No reader available');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'status') {
                const statusId = `status-${data.stage}`;
                const statusMsg: ChatMessage = {
                  id: statusId,
                  type: 'status',
                  content: data.message,
                  stage: data.stage,
                  isStreaming: true,
                };
                statusMessages.set(statusId, statusMsg);
                setMessages((prev) => {
                  const filtered = prev.filter((m) => m.id !== statusId);
                  return [...filtered, statusMsg];
                });
              } else if (data.type === 'plan') {
                setMessages((prev) => prev.filter((m) => m.id !== 'status-planning'));
              } else if (data.type === 'task_update') {
                const taskStatusId = `task-${data.taskId}`;
                const taskDesc = data.description || 'Executing task...';
                const taskTool = data.tool || 'unknown';
                let statusContent = '';
                
                if (data.status === 'running') {
                  statusContent = `Executing: ${taskDesc} (${taskTool})`;
                } else if (data.status === 'completed') {
                  statusContent = `✅ Completed: ${taskDesc}`;
                } else if (data.status === 'failed') {
                  statusContent = `❌ Failed: ${taskDesc}`;
                } else if (data.status === 'skipped') {
                  statusContent = `⏭️ Skipped: ${taskDesc}`;
                }
                
                if (statusContent) {
                  setMessages((prev) => {
                    const filtered = prev.filter((m) => m.id !== taskStatusId);
                    return [...filtered, {
                      id: taskStatusId,
                      type: 'status',
                      content: statusContent,
                      stage: 'executing',
                      isStreaming: data.status === 'running',
                    }];
                  });
                }
              } else if (data.type === 'complete') {
                setMessages((prev) => {
                  let finalContent = data.summary?.finalAnswer || 'Execution completed.';
                  
                  const hasSources = finalContent.includes('**Sources:**') || finalContent.includes('Sources:');
                  
                  if (!hasSources && data.summary?.sources && data.summary.sources.length > 0) {
                    finalContent += '\n\n**Sources:**\n';
                    data.summary.sources.forEach((source: any, idx: number) => {
                      finalContent += `${idx + 1}. [${source.title}](${source.url})\n`;
                    });
                  }
                  
                  const filtered = prev.filter((m) => 
                    !m.id.startsWith('task-') && !m.id.startsWith('final-response-') && !m.id.startsWith('error-') && m.type !== 'status'
                  );
                  
                  return [...filtered, {
                    id: `final-response-${Date.now()}`,
                    type: 'assistant',
                    content: finalContent,
                  }];
                });
              } else if (data.type === 'error') {
                setMessages((prev) => {
                  const filtered = prev.filter((m) => 
                    m.type !== 'status' && !m.id.startsWith('error-') && !m.id.startsWith('final-response-')
                  );
                  return [...filtered, {
                    id: `error-${Date.now()}`,
                    type: 'assistant',
                    content: 'Something went wrong. Please try again.',
                  }];
                });
              }
            } catch (parseError) {
              console.error('Error parsing SSE data:', parseError);
            }
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const filtered = prev.filter((m) => 
          m.type !== 'status' && !m.id.startsWith('error-') && !m.id.startsWith('final-response-')
        );
        return [...filtered, {
          id: `error-${Date.now()}`,
          type: 'assistant',
          content: 'Something went wrong. Please try again.',
        }];
      });
    } finally {
      setIsLoading(false);
      setMessages((prev) => prev.map((m) => ({ ...m, isStreaming: false })));
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Aurexis Powered Agent
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  message.type === 'user'
                    ? 'bg-blue-600 text-white'
                    : message.type === 'status'
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow'
                }`}
              >
                {message.type === 'status' && message.isStreaming && (
                  <span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-2 animate-pulse"></span>
                )}
                {message.type === 'assistant' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&_strong]:font-bold [&_strong]:text-gray-900 dark:[&_strong]:text-gray-100 [&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a]:underline [&_ul]:list-disc [&_ul]:ml-6 [&_ol]:list-decimal [&_ol]:ml-6">
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">
                    {message.content}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter your goal..."
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-semibold"
            >
              {isLoading ? 'Processing...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
