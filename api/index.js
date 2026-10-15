// This file contains a serverless function that generates a PDF from HTML using Puppeteer and pdf-lib.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts, PDFName, PDFHexString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    // Extract the new product_slug from the request body
    const { html, configurator_options, product_slug } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    const cleanHtml = html.replace(/\\n/g, '');

    chromium.setGraphicsMode = false;

    // 1. LAUNCH SERVERLESS BROWSER
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });

    await page.addStyleTag({
      content: `
        @media print {
          @page { size: 8.5in 11in; margin: 0 !important; }
          html, body { 
            margin: 0 !important; 
            padding: 0 !important; 
            background: white !important; 
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important;
          }
          .page-wrapper {
            width: 8.5in !important;
            height: 11in !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
            border: none !important;
            page-break-after: always !important;
            break-after: page !important;
            overflow: hidden !important;
            position: relative !important;
          }
          .page-wrapper:last-of-type {
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
        }
      `
    });

    // Bump deviceScaleFactor to 2 to eliminate thick, low-res chunky borders
    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 2 });
    await page.emulateMediaType('print');

    // 2. EXTRACT DOM COORDINATES
    const domExtraction = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('.page-wrapper'));
      wrappers.forEach((wrapper, index) => {
        const pageNo = wrapper.querySelector('#spec-current-page-no');
        const totalNo = wrapper.querySelector('#spec-total-pages-count');
        if (pageNo) pageNo.innerText = String(index + 1);
        if (totalNo) totalNo.innerText = String(wrappers.length);
      });

      const items = document.querySelectorAll('[data-step]');
      const coords = [];

      items.forEach(item => {
        const chkbx = item.querySelector('.ordering-code-chkbx');
        const targetElement = chkbx ? chkbx : item;

        const rect = targetElement.getBoundingClientRect();
        const pageWrapper = targetElement.closest('.page-wrapper');

        if (!pageWrapper) return;

        const pageIndex = wrappers.indexOf(pageWrapper);
        const wrapperRect = pageWrapper.getBoundingClientRect();

        const relativeLeft = rect.left - wrapperRect.left;
        const relativeTop = rect.top - wrapperRect.top;

        coords.push({
          step: item.getAttribute('data-step'),
          code: item.getAttribute('data-code'),
          pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
          x: relativeLeft * 0.75,
          y: 792 - (relativeTop * 0.75) - (rect.height * 0.75),
          width: rect.width * 0.75,
          height: rect.height * 0.75
        });
      });

      let codeBoxCoords = null;
      const codeBox = document.querySelector('#spec-ordering-code-input');
      if (codeBox) {
        const rect = codeBox.getBoundingClientRect();
        const pageWrapper = codeBox.closest('.page-wrapper');
        if (pageWrapper) {
          const wrapperRect = pageWrapper.getBoundingClientRect();
          const pageIndex = wrappers.indexOf(pageWrapper);

          codeBoxCoords = {
            pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
            x: (rect.left - wrapperRect.left) * 0.75,
            y: 792 - ((rect.top - wrapperRect.top) * 0.75) - (rect.height * 0.75),
            width: rect.width * 0.75,
            height: rect.height * 0.75
          };

          codeBox.style.color = 'transparent';
          codeBox.style.background = 'transparent';
          codeBox.style.backgroundColor = 'transparent';
        }
      }

      return { coords, codeBoxCoords };
    });

    // 3. SNAP BASE PDF
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });

    await browser.close();

    // 4. LOAD PDF-LIB TO STAMP INTERACTIVE ACROFORMS
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    let customFont;
    try {
      const fontPath = path.join(process.cwd(), 'fonts', 'NotoSerif-SemiBold.ttf');
      const fontBytes = fs.readFileSync(fontPath);
      customFont = await pdfDoc.embedFont(fontBytes, { subset: false });
    } catch (err) {
      console.log('Falling back to built-in Times Roman:', err);
      customFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // --- A. HEADER TEXT INPUTS ---
    const headerConfigs = [
      { name: 'project_name', x: 79, y: 705, width: 130, height: 16 },
      { name: 'fixture_type', x: 267, y: 705, width: 130, height: 16 },
      { name: 'project_location', x: 442, y: 705, width: 140, height: 16 }
    ];

    headerConfigs.forEach(cfg => {
      const tf = form.createTextField(cfg.name);
      pages.forEach(p => {
        tf.addToPage(p, {
          x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
          borderWidth: 0, backgroundColor: rgb(1, 1, 1), textColor, font: customFont,
        });
      });
      tf.setFontSize(10);
    });

    // --- B. INTERACTIVE RADIO BUTTONS & LENGTH INPUT OVERLAYS ---
    const domCoords = domExtraction.coords;

    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const stepStr = String(step.option_step);
        const stepName = `step_${stepStr}`;
        const stepCoords = domCoords.filter(c => c.step === stepStr);

        if (stepCoords.length === 0) return;

        if (step.option_type === "Length") {
          const lengthCoord = stepCoords[0];
          const targetPage = pages[lengthCoord.pageIndex] || pages[pages.length - 1];
          const lengthField = form.createTextField(stepName);

          lengthField.addToPage(targetPage, {
            x: lengthCoord.x,
            y: lengthCoord.y - 1,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: textColor, textColor, font: customFont,
          });
          lengthField.setFontSize(9);

        } else {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          let allowedValues = [];
          try {
            allowedValues = typeof step.allowed_values_json === 'string'
              ? JSON.parse(step.allowed_values_json)
              : step.allowed_values_json;
          } catch (e) {}
          if (!Array.isArray(allowedValues)) allowedValues = [];

          stepCoords.forEach((coord) => {
            const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: coord.x, y: coord.y, width: coord.width || 7, height: coord.height || 7,
              borderWidth: 0, borderColor: textColor,
            });
          });

          // Check for pre-selection based on requirements
          if (step.is_required == 1 || step.is_required === true) {
            // If there's only one option, automatically pre-select it
            if (allowedValues.length === 1) {
              defaultSelectedCode = String(allowedValues[0].code || allowedValues[0].value);
            } else {
              // Otherwise, look for an explicitly declared default
              allowedValues.forEach((valObj) => {
                if (valObj.is_default === 1 && !defaultSelectedCode) {
                  defaultSelectedCode = String(valObj.code || valObj.value);
                }
              });
            }
          }

          if (defaultSelectedCode) {
            try { radioGroup.select(defaultSelectedCode); } catch (e) {}
          }
        }
      });
    }

    // --- C. DYNAMIC ACROJS ORDERING CODE GENERATOR ---
    const codeBox = domExtraction.codeBoxCoords;
    if (codeBox && Array.isArray(configurator_options)) {
      const targetPage = pages[codeBox.pageIndex] || pages[pages.length - 1];
      const orderingCodeField = form.createTextField('SpecOrderingCode');

      orderingCodeField.addToPage(targetPage, {
        x: codeBox.x,
        y: codeBox.y + 1,
        width: codeBox.width,
        height: codeBox.height - 2.5,
        font: customFont,
        textColor: textColor,
        borderWidth: 0,
      });
      orderingCodeField.setFontSize(10);

      // 1. Sort steps by index
      const acroSteps = configurator_options.map(s => ({
        stepName: 'step_' + s.option_step,
        type: s.option_type,
        label: s.option_label || ''
      })).sort((a, b) => parseInt(a.stepName.split('_')[1]) - parseInt(b.stepName.split('_')[1]));

      const safeSlug = (product_slug || "").toUpperCase();

      // 2. Pre-calculate the initial default value on generation
      let initialSegments = [];
      if (safeSlug) initialSegments.push(safeSlug);
      
      let initialDir = "";
      for (let i = 0; i < acroSteps.length; i++) {
        let field;
        try { field = form.getField(acroSteps[i].stepName); } catch (e) { field = null; }
        if (field) {
          let val = (typeof field.getSelected === 'function') ? field.getSelected() : field.getText();
          if (val && val !== "Off" && val !== "") {
            let isDir = acroSteps[i].type === "Feed Direction" && acroSteps[i].label.includes("Direction");
            let isLen = acroSteps[i].type === "Feed Direction" && acroSteps[i].label.includes("Length");

            if (isDir) {
              initialDir = val;
            } else if (isLen) {
              initialSegments.push(initialDir + val);
              initialDir = "";
            } else {
              initialSegments.push(val);
            }
          }
        }
      }
      orderingCodeField.setText(initialSegments.join('-'));

      // 3. Flatten metadata for the browsers' limited AcroJS engines
      const stepNames = acroSteps.map(s => s.stepName);
      const isDirFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Direction")));
      const isLenFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Length")));

      // 4. The calculate script (plain ES5, wrapped in try/catch)
      const acroCalcScript = `
try {
  var fields = ${JSON.stringify(stepNames)};
  var isDir = ${JSON.stringify(isDirFlags)};
  var isLen = ${JSON.stringify(isLenFlags)};
  
  var segments = [];
  var slug = "${safeSlug}";
  if (slug) segments.push(slug);
  
  var dirVal = "";
  for (var i = 0; i < fields.length; i++) {
    var f = this.getField(fields[i]);
    var v = f ? f.value : "";
    if (v && v !== "Off") {
      if (isDir[i]) { dirVal = v; }
      else if (isLen[i]) { segments.push(dirVal + v); dirVal = ""; }
      else { segments.push(v); }
    }
  }
  event.value = segments.join("-");
} catch (e) {}
`;

      // 5. Bind the script to the Calculate (C) event of the text field
      const calcAction = pdfDoc.context.register(pdfDoc.context.obj({
        S: 'JavaScript',
        JS: PDFHexString.fromText(acroCalcScript),
      }));

      const aaDict = pdfDoc.context.obj({ C: calcAction });
      orderingCodeField.acroField.dict.set(PDFName.of('AA'), aaDict);
      orderingCodeField.acroField.getWidgets().forEach(w =>
        w.dict.set(PDFName.of('AA'), aaDict));

      // 6. Register the field in the document calculation order (CO)
      form.acroForm.dict.set(
        PDFName.of('CO'),
        pdfDoc.context.obj([orderingCodeField.acroField.ref])
      );

      // 7. Ask viewers to redraw field appearances when values change
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), pdfDoc.context.obj(true));
    }

    form.updateFieldAppearances(customFont);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
