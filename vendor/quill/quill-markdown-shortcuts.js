/**
 * Quill Markdown Shortcuts Plugin (Inline Fixed Version)
 * Original Author: Patrick Lee
 * Modified for Standalone & Inline Support
 */
(function() {
  var Quill = window.Quill;
  if (!Quill) {
    console.error("Quill JS가 로드되지 않았습니다.");
    return;
  }

  // 가로줄(hr) 포맷 등록
  var BlockEmbed = Quill.import('blots/block/embed');
  class HorizontalRule extends BlockEmbed {}
  HorizontalRule.blotName = 'hr';
  HorizontalRule.tagName = 'hr';
  Quill.register('formats/horizontal', HorizontalRule);

  class MarkdownShortcuts {
    constructor(quill, options) {
      this.quill = quill;
      this.options = options;

      // [1] 블록 패턴 (문장 맨 앞에서만 작동)
      this.blockMatches = [
        {
          name: 'header',
          pattern: /^(#){1,6}\s$/g, // # 스페이스
          action: (text, selection, pattern) => {
            var match = pattern.exec(text);
            if (!match) return;
            var size = match[0].length - 1; // # 개수
            setTimeout(() => {
              this.quill.formatLine(selection.index, 0, 'header', size);
              this.quill.deleteText(selection.index - (size + 1), size + 1);
            }, 0);
          }
        },
        {
          name: 'blockquote',
          pattern: /^>\s$/g, // > 스페이스
          action: (text, selection) => {
            setTimeout(() => {
              this.quill.formatLine(selection.index, 1, 'blockquote', true);
              this.quill.deleteText(selection.index - 2, 2);
            }, 0);
          }
        },
        {
          name: 'code-block',
          pattern: /^`{3}\s$/g, // ``` 스페이스
          action: (text, selection) => {
            setTimeout(() => {
              this.quill.formatLine(selection.index, 1, 'code-block', true);
              this.quill.deleteText(selection.index - 4, 4);
            }, 0);
          }
        },
        {
          name: 'list-ul',
          pattern: /^[-*+]\s$/g, // - 또는 * 또는 + 스페이스
          action: (text, selection) => {
            setTimeout(() => {
              this.quill.formatLine(selection.index, 1, 'list', 'unordered');
              this.quill.deleteText(selection.index - 2, 2);
            }, 0);
          }
        },
        {
          name: 'list-ol',
          pattern: /^1\.\s$/g, // 1. 스페이스
          action: (text, selection) => {
            setTimeout(() => {
              this.quill.formatLine(selection.index, 1, 'list', 'ordered');
              this.quill.deleteText(selection.index - 3, 3);
            }, 0);
          }
        },
        {
          name: 'hr',
          pattern: /^([-*])\1{2,}\s$/g, // --- 또는 *** 스페이스
          action: (text, selection) => {
            setTimeout(() => {
               // 현재 라인의 텍스트를 모두 지우고 HR 삽입
               const [line, offset] = this.quill.getLine(selection.index);
               const lineLength = line.length();
               const lineStart = selection.index - offset;
               
               this.quill.deleteText(lineStart, lineLength);
               this.quill.insertEmbed(lineStart, 'hr', true, Quill.sources.USER);
               this.quill.insertText(lineStart + 1, "\n", Quill.sources.SILENT); 
            }, 0);
          }
        }
      ];

      // [2] 인라인 패턴 (문장 중간에서도 작동 - 커서 바로 앞 검사)
      // 주의: 정규식 끝에 $를 붙여서 '바로 앞'인지 확인
      this.inlineMatches = [
        {
          name: 'bold',
          pattern: /\*\*([^\*]+)\*\*$/g, // **굵게**
          format: { bold: true }
        },
        {
            name: 'bold-under',
            pattern: /__([^_]+)__$/g, // __굵게__
            format: { bold: true }
        },
        {
          name: 'italic',
          pattern: /\*([^\*]+)\*$/g, // *기울임*
          format: { italic: true }
        },
        {
            name: 'italic-under',
            pattern: /_([^_]+)_$/g, // _기울임_
            format: { italic: true }
        },
        {
          name: 'strike',
          pattern: /~~([^~]+)~~$/g, // ~~취소선~~
          format: { strike: true }
        },
        {
          name: 'code',
          pattern: /`([^`]+)`$/g, // `코드`
          format: { code: true }
        }
      ];

      // 텍스트 변경 감지
      this.quill.on('text-change', (delta, oldContents, source) => {
        for (let i = 0; i < delta.ops.length; i++) {
          if (delta.ops[i].hasOwnProperty('insert')) {
            if (delta.ops[i].insert === ' ') {
              this.onSpace();
            }
          }
        }
      });
    }

    onSpace() {
      const selection = this.quill.getSelection();
      if (!selection) return;
      
      const [line, offset] = this.quill.getLine(selection.index);
      const text = line.domNode.textContent;
      const lineStart = selection.index - offset;
      
      // 스페이스가 이미 입력된 후이므로, offset이 스페이스를 포함한 위치
      // 커서 위치까지의 텍스트 (스페이스 포함)
      const textBeforeCursor = text.slice(0, offset);
      
      // 1. 블록 패턴 확인 (줄 전체가 패턴과 일치하는지)
      for (let match of this.blockMatches) {
        // 블록 패턴은 '문자+스페이스'로 끝나야 함
        match.pattern.lastIndex = 0; // 정규식 상태 초기화
        const matchResult = match.pattern.exec(textBeforeCursor); 
        if (matchResult) {
            match.action(text, selection, match.pattern);
            return;
        }
      }

      // 2. 인라인 패턴 확인 (커서 바로 앞 단어 확인)
      // 스페이스 입력 직전 텍스트를 검사 (마지막 스페이스 제거)
      const textWithoutLastSpace = textBeforeCursor.slice(0, -1);
      
      for (let match of this.inlineMatches) {
        match.pattern.lastIndex = 0; // 정규식 상태 초기화
        const matchResult = match.pattern.exec(textWithoutLastSpace);
        if (matchResult) {
            const fullMatch = matchResult[0]; // 예: **굵게**
            const contentText = matchResult[1]; // 예: 굵게
            const startIndex = lineStart + matchResult.index;

            setTimeout(() => {
                this.quill.deleteText(startIndex, fullMatch.length); // **굵게** 삭제
                this.quill.insertText(startIndex, contentText, match.format); // 굵게 삽입 (서식 적용)
                this.quill.setSelection(startIndex + contentText.length + 1); // 스페이스 다음으로 커서 이동
                this.quill.format('bold', false); // 서식 초기화 (다음 글자는 평범하게)
                this.quill.format('italic', false);
                this.quill.format('strike', false);
                this.quill.format('code', false);
            }, 0);
            return;
        }
      }
    }
  }``

  window.MarkdownShortcuts = MarkdownShortcuts;
  Quill.register('modules/markdownShortcuts', MarkdownShortcuts);
  console.log('Quill Markdown Shortcuts (Inline Fixed) Loaded');
})();