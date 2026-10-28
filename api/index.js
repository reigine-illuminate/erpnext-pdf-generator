// This file contains a serverless function that generates a PDF from HTML using Puppeteer and pdf-lib.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts, PDFName, PDFString, PDFDict, PDFArray } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    // 1. EXTRACT BRAND FROM PAYLOAD
    const { html, configurator_options, product_slug, brand } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    const cleanHtml = html.replace(/\\n/g, '');
    chromium.setGraphicsMode = false;

    // 2. LAUNCH SERVERLESS BROWSER
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });

    // 3. DYNAMIC CSS (Restoring your Webflow 36px Padding!)
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
            /* Dynamically apply 36px padding for ilLumenate */
            padding: ${brand === 'illumenate' ? '36px' : '0'} !important;
            box-sizing: border-box !important;
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

    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 2 });
    await page.emulateMediaType('print');

    // 4. EXTRACT DOM COORDINATES
    const domExtraction = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('.page-wrapper'));
      wrappers.forEach((wrapper, index) => {
        const pageNo = wrapper.querySelector('#current-page-no') || wrapper.querySelector('#spec-current-page-no');
        const totalNo = wrapper.querySelector('#total-page-no') || wrapper.querySelector('#spec-total-pages-count');
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

      const highlightItems = document.querySelectorAll('[data-highlight]');
      const highlightCoords = [];

      highlightItems.forEach(item => {
        const rect = item.getBoundingClientRect();
        const pageWrapper = item.closest('.page-wrapper');
        if (!pageWrapper) return;

        const pageIndex = wrappers.indexOf(pageWrapper);
        const wrapperRect = pageWrapper.getBoundingClientRect();

        let relativeLeft = rect.left - wrapperRect.left;
        let relativeTop = rect.top - wrapperRect.top;
        let elemWidth = rect.width;
        let elemHeight = rect.height;

        const tableContainer = item.closest('#spec-dynamic-table-container');
        if (tableContainer) {
          const contRect = tableContainer.getBoundingClientRect();
          relativeLeft = contRect.left - wrapperRect.left;
          elemWidth = contRect.width;
        }

        const code = item.getAttribute('data-highlight') || '';

        highlightCoords.push({
          code: code.trim(),
          pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
          x: relativeLeft * 0.75,
          y: 792 - (relativeTop * 0.75) - (elemHeight * 0.75),
          width: elemWidth * 0.75,
          height: elemHeight * 0.75,
          isRow: !!tableContainer
        });
      });

      return { coords, codeBoxCoords, highlightCoords };
    });

    // 5. SNAP BASE PDF (Margins dictated by 0px full-bleed setting)
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });

    await browser.close();

    // 6. LOAD PDF-LIB TO STAMP INTERACTIVE ACROFORMS
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    if (domExtraction.highlightCoords && domExtraction.highlightCoords.length > 0) {
      pdfDoc.setSubject(JSON.stringify(domExtraction.highlightCoords));
    }

    // 7. DYNAMIC FONT LOADING
    // Use Standard PDF fonts for interactive fields to prevent glyph encoding corruption.
    // Puppeteer already rendered the custom Webflow fonts in the background!
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    
    // ilLumenate gets clean sans-serif (Helvetica), 206 gets serif (Times)
    const liveFont = brand === 'illumenate' ? helvetica : timesRoman;

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    // Register the standard font in the AcroForm Default Resources
    form.acroForm.dict.set(PDFName.of('DR'), pdfDoc.context.obj({
      Font: { [liveFont.name]: liveFont.ref }
    }));
    form.acroForm.dict.set(PDFName.of('DA'), PDFString.of(`/${liveFont.name} 0 Tf 0 g`));
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // --- A. DYNAMIC PROJECT DETAILS TEXT INPUTS ---
    let headerConfigs = [];
    
    if (brand === 'illumenate') {
      // Calculated Footer Coordinates
      headerConfigs = [
        // Starts after "PROJECT NAME" text, spans until "FIXTURE TYPE"
        { name: 'project_name', x: 75, y: 46, width: 187, height: 14 },
        
        // Starts after "FIXTURE TYPE" text, spans until "LOCATION"
        { name: 'fixture_type', x: 310, y: 46, width: 100, height: 14 },
        
        // Starts after "LOCATION" text, spans to the 36px right margin
        { name: 'project_location', x: 475, y: 46, width: 100, height: 14 }
      ];
    } else {
      // 206 Lighting Coordinates
      headerConfigs = [
        { name: 'project_name', x: 79, y: 705, width: 130, height: 16 },
        { name: 'fixture_type', x: 267, y: 705, width: 130, height: 16 },
        { name: 'project_location', x: 442, y: 705, width: 140, height: 16 }
      ];
    }

    headerConfigs.forEach(cfg => {
      const tf = form.createTextField(cfg.name);
      pages.forEach(p => {
        if (pages.indexOf(p) < 2) {
            tf.addToPage(p, {
              x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
              borderWidth: 0, backgroundColor: rgb(1, 1, 1), textColor, font: liveFont,
            });
        }
      });
      tf.setFontSize(10);
      tf.updateAppearances(liveFont);
    });

    // --- B. INTERACTIVE RADIO BUTTONS & LENGTH INPUT OVERLAYS ---
    const domCoords = domExtraction.coords;
    
    const safeSlug = (product_slug || "").toUpperCase();
    if (Array.isArray(configurator_options) && safeSlug) {
      const hasSeries = configurator_options.some(c => c.option_step === 0 && c.option_type === "Series");
      if (!hasSeries) {
        configurator_options.unshift({
          option_step: 0,
          option_type: "Series",
          is_required: 1,
          allowed_values: [{ code: safeSlug }]
        });
      }
    }

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
            borderWidth: 0.5, borderColor: textColor, textColor, font: liveFont,
          });
          lengthField.setFontSize(9);
          lengthField.updateAppearances(liveFont);

        } else {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          let allowedValues = Array.isArray(step.allowed_values) ? step.allowed_values : [];

          stepCoords.forEach((coord) => {
            const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: coord.x, y: coord.y, width: coord.width || 7, height: coord.height || 7,
              borderWidth: 0.5, borderColor: textColor,
            });
          });

          if (step.is_required == 1 || step.is_required === true) {
            if (allowedValues.length === 1) {
              defaultSelectedCode = String(allowedValues[0].code || allowedValues[0].value);
            } else {
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
        font: liveFont,
        textColor: textColor,
        borderWidth: 0,
      });
      orderingCodeField.setFontSize(10);

      const acroSteps = configurator_options.map(s => ({
        stepName: 'step_' + s.option_step,
        type: s.option_type,
        label: s.option_label || ''
      })).sort((a, b) => parseInt(a.stepName.split('_')[1]) - parseInt(b.stepName.split('_')[1]));

      let initialSegments = [];
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
              if (initialDir) initialSegments.push(initialDir);
              initialDir = val;
            } else if (isLen) {
              initialSegments.push(initialDir + val);
              initialDir = "";
            } else {
              if (initialDir) { initialSegments.push(initialDir); initialDir = ""; }
              initialSegments.push(val);
            }
          }
        }
      }
      if (initialDir) initialSegments.push(initialDir);
      orderingCodeField.setText(initialSegments.join('-'));
      orderingCodeField.updateAppearances(liveFont);

      const stepNames = acroSteps.map(s => s.stepName);
      const isDirFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Direction")));
      const isLenFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Length")));

      const acroCalcScript = `var fields = ${JSON.stringify(stepNames)};
var isDir = ${JSON.stringify(isDirFlags)};
var isLen = ${JSON.stringify(isLenFlags)};
var parts = [];
var dirVal = "";
for (var i = 0; i < fields.length; i++) {
  var f = this.getField(fields[i]);
  if (!f) continue;
  var v = f.value;
  if (v === null || v === undefined) continue;
  v = String(v);
  
  if (v === "0") v = ""; 
  
  if (v === "Off" || v === "" || v === "__none__") continue;
  if (isDir[i]) {
    if (dirVal) parts.push(dirVal);
    dirVal = v;
  } else if (isLen[i]) {
    parts.push(dirVal + v);
    dirVal = "";
  } else {
    if (dirVal) { parts.push(dirVal); dirVal = ""; }
    parts.push(v);
  }
}
if (dirVal) parts.push(dirVal);
event.value = parts.join("-");`;

      const jsStreamRef = pdfDoc.context.register(pdfDoc.context.flateStream(acroCalcScript));
      const calcAction = pdfDoc.context.register(pdfDoc.context.obj({
        S: 'JavaScript',
        JS: jsStreamRef,
      }));

      orderingCodeField.acroField.dict.set(PDFName.of('AA'), pdfDoc.context.obj({ C: calcAction }));

      const fieldRef = orderingCodeField.acroField.ref;
      const fieldDict = orderingCodeField.acroField.dict;
      const widgetRef = fieldDict.lookup(PDFName.of('Kids'), PDFArray).get(0);
      const widgetDict = pdfDoc.context.lookup(widgetRef, PDFDict);
      ['T', 'FT', 'Ff', 'V', 'DA', 'AA'].forEach((k) => {
        const val = fieldDict.get(PDFName.of(k));
        if (val) widgetDict.set(PDFName.of(k), val);
      });
      widgetDict.delete(PDFName.of('Parent'));

      const fieldsArr = form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
      for (let i = 0; i < fieldsArr.size(); i++) {
        if (String(fieldsArr.get(i)) === String(fieldRef)) fieldsArr.set(i, widgetRef);
      }
      form.acroForm.dict.set(PDFName.of('CO'), pdfDoc.context.obj([widgetRef]));
      form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
    }

    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
