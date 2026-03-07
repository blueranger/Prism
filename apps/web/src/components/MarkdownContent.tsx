'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Shared Markdown renderer for LLM responses.
 * Renders markdown formatting (bold, lists, headers, code, tables, etc.)
 * with dark-theme styling consistent with Prism's UI.
 */
export default function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  if (!content) return null;

  return (
    <div className={`text-sm text-gray-300 leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          // Headings
          h1: ({ children }) => <h3 className="text-base font-bold text-gray-100 mt-4 mb-2">{children}</h3>,
          h2: ({ children }) => <h4 className="text-sm font-bold text-gray-100 mt-3 mb-2">{children}</h4>,
          h3: ({ children }) => <h5 className="text-sm font-semibold text-gray-200 mt-2 mb-1">{children}</h5>,
          h4: ({ children }) => <h6 className="text-sm font-medium text-gray-200 mt-2 mb-1">{children}</h6>,
          // Lists
          ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="mb-1">{children}</li>,
          // Code
          code: ({ children, className: codeClassName }) => {
            const isBlock = codeClassName?.includes('language-');
            if (isBlock) {
              return (
                <code className="block bg-gray-900 rounded-md p-3 text-xs text-gray-300 overflow-x-auto my-2">
                  {children}
                </code>
              );
            }
            return <code className="bg-gray-700/50 rounded px-1.5 py-0.5 text-xs text-indigo-300">{children}</code>;
          },
          pre: ({ children }) => <pre className="my-2">{children}</pre>,
          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-indigo-500/50 pl-3 my-2 text-gray-400 italic">
              {children}
            </blockquote>
          ),
          // Tables
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="text-xs border-collapse border border-gray-700 w-full">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-800">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-gray-700 px-2 py-1 text-left text-gray-300 font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-700 px-2 py-1 text-gray-400">{children}</td>
          ),
          // Links
          a: ({ href, children }) => (
            <a href={href} className="text-indigo-400 hover:text-indigo-300 underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Horizontal rules
          hr: () => <hr className="border-gray-700 my-3" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
