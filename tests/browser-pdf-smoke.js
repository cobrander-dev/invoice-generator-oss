'use strict';

(function runBrowserPdfSmokeTest() {
  const result = document.getElementById('result');
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.text('PHASE 6 TEST PDF', 20, 20);
    doc.autoTable({ startY: 30, head: [['TEST']], body: [['TEST ROW']] });
    const payload = {
      status: 'PASS',
      jspdfLoaded: typeof jsPDF === 'function',
      autoTableLoaded: typeof doc.autoTable === 'function',
      pages: doc.getNumberOfPages(),
      bytes: doc.output('arraybuffer').byteLength,
      textPresent: doc.internal.pages.flat().join('\n').includes('PHASE 6 TEST PDF'),
    };
    result.textContent = JSON.stringify(payload);
  } catch (error) {
    result.textContent = JSON.stringify({ status: 'FAIL', message: error.message });
  }
})();
