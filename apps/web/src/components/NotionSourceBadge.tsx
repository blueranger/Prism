'use client';

interface NotionSourceBadgeProps {
  sourceLabel: string;
  notionUrl?: string;
}

export default function NotionSourceBadge({ sourceLabel, notionUrl }: NotionSourceBadgeProps) {
  const content = (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-400 border border-gray-700/50 hover:text-indigo-300 hover:border-indigo-700/50 transition-colors">
      <span>📄</span>
      <span>Based on: {sourceLabel}</span>
    </span>
  );

  if (notionUrl) {
    return (
      <a href={notionUrl} target="_blank" rel="noopener noreferrer" className="no-underline">
        {content}
      </a>
    );
  }

  return content;
}
