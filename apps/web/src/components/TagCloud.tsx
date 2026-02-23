'use client';

import type { Tag } from '@prism/shared';

interface TagCloudProps {
  tags: Tag[];
  onTagClick?: (tag: Tag) => void;
}

export default function TagCloud({ tags, onTagClick }: TagCloudProps) {
  if (tags.length === 0) return null;

  const maxCount = Math.max(...tags.map(t => t.conversationCount || 1));

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const ratio = (tag.conversationCount || 1) / maxCount;
        const fontSize = 10 + ratio * 6; // 10px to 16px

        return (
          <button
            key={tag.id}
            onClick={() => onTagClick?.(tag)}
            className="px-2 py-0.5 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors border border-gray-700"
            style={{ fontSize: `${fontSize}px` }}
            title={`${tag.conversationCount || 0} conversations`}
          >
            {tag.name}
            {tag.conversationCount ? (
              <span className="ml-1 text-gray-600">{tag.conversationCount}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
