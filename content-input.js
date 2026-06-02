(function () {
  const INPUT_VERSION = '2026-06-02.input-v1';
  if (window.PromptQueueInput?.version === INPUT_VERSION) return;

  function isContentEditableElement(el) {
    if (!el || !el.getAttribute) return false;
    const attr = el.getAttribute('contenteditable');
    return attr === ''
      || attr === 'true'
      || attr === 'plaintext-only'
      || el.isContentEditable === true
      || el.contentEditable === 'true'
      || el.contentEditable === 'plaintext-only';
  }

  function collapseSelectionToEnd(el) {
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  function dispatchComposerInputEvents(el, text) {
    const eventInit = {
      data: String(text || ''),
      inputType: 'insertText',
      bubbles: true,
      cancelable: true,
      isComposing: false,
    };
    try {
      el.dispatchEvent(new InputEvent('input', eventInit));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function htmlEscape(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function setProseMirrorText(el, text) {
    const value = String(text || '');
    el.focus({ preventScroll: true });

    if (typeof document.execCommand === 'function') {
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);

        if (el.getAttribute('contenteditable') === 'plaintext-only') {
          if (document.execCommand('insertText', false, value)) {
            dispatchComposerInputEvents(el, value);
            collapseSelectionToEnd(el);
            return;
          }
        } else {
          const paragraphs = value
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => line.length === 0 ? '<p><br></p>' : `<p>${htmlEscape(line)}</p>`)
            .join('');
          if (document.execCommand('insertHTML', false, paragraphs)) {
            dispatchComposerInputEvents(el, value);
            collapseSelectionToEnd(el);
            return;
          }
        }

        const maxChunk = 4000;
        let inserted = false;
        for (let i = 0; i < value.length; i += maxChunk) {
          inserted = document.execCommand('insertText', false, value.slice(i, i + maxChunk)) || inserted;
        }
        if (inserted || value.length === 0) {
          dispatchComposerInputEvents(el, value);
          collapseSelectionToEnd(el);
          return;
        }
      } catch (_) {}
    }

    el.textContent = value;
    dispatchComposerInputEvents(el, value);
    collapseSelectionToEnd(el);
  }

  function replacePlainContentEditableText(el, text) {
    const value = String(text || '');
    el.focus({ preventScroll: true });
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, value)) {
        dispatchComposerInputEvents(el, value);
        collapseSelectionToEnd(el);
        return;
      }
      range.deleteContents();
      range.insertNode(document.createTextNode(value));
    } catch (_) {
      el.textContent = value;
    }
    collapseSelectionToEnd(el);
    dispatchComposerInputEvents(el, value);
  }

  function setNativeInputValue(el, text) {
    const value = String(text || '');
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    el.focus({ preventScroll: true });
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    try {
      if (typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(value.length, value.length);
      } else if ('selectionStart' in el && 'selectionEnd' in el) {
        el.selectionStart = value.length;
        el.selectionEnd = value.length;
      }
    } catch (_) {}
    dispatchComposerInputEvents(el, value);
  }

  function setTextInInput(el, text) {
    if (!el) throw new Error('Input element not found');
    if (isContentEditableElement(el)) {
      if (el.id === 'prompt-textarea' || el.classList.contains('ProseMirror')) {
        setProseMirrorText(el, text);
      } else {
        replacePlainContentEditableText(el, text);
      }
      return;
    }
    setNativeInputValue(el, text);
  }

  function getInputCurrentTextQuiet(el) {
    if (!el) return '';
    if (isContentEditableElement(el)) return el.textContent || '';
    if (typeof el.value === 'string') return el.value;
    return el.textContent || '';
  }

  function getInputCurrentText(el) {
    const text = getInputCurrentTextQuiet(el);
    console.log('[GetInputCurrentText] Read text from input', { length: text.length });
    return text;
  }

  function getInputTextLengthQuiet(el) {
    return getInputCurrentTextQuiet(el).length;
  }

  window.PromptQueueInput = Object.freeze({
    version: INPUT_VERSION,
    collapseSelectionToEnd,
    dispatchComposerInputEvents,
    getInputCurrentText,
    getInputCurrentTextQuiet,
    getInputTextLengthQuiet,
    isContentEditableElement,
    setTextInInput,
  });
})();
