const spawn   = require('child_process').spawn;
const fs      = require('fs');
const path    = require('path');
const _       = require('lodash');
const Q       = require('q');
const cheerio = require('cheerio');

const HTMLBaseConverter = require('./html-base');
const Chapter           = require('./types/chapter');
const Readme            = require('./types/readme');
const utils             = require('./utils');

const logger = new utils.Logger('log');

class DocbookConverter extends HTMLBaseConverter {
    // Implement toHTML()
    toHTML() {
        const d = Q.defer();

        logger.log('Converting Docbook to HTML...');
        // HTML output filename
        const output     = path.resolve(path.dirname(this.originalDoc.path), this.documentTitle) + '.html';
        const resources  = path.resolve(__dirname, '../../resources/docbook/xhtml5/docbook.xsl');
        const stylesheet = 'docbook.css';

        const xsltproc = spawn('xsltproc', [
            '--output', output,
            resources,
            this.originalDoc.path
        ]);

        xsltproc.stdout.on('data', data => logger.log(data.toString()));

        xsltproc.stderr.on('data', (data) => {
            if (this.debug) {
                logger.log(data.toString());
            }
        });

        xsltproc.on('close', (code) => {
            if (code !== 0) {
                d.reject(`xsltproc failed with exit code ${code}`);
            }

            fs.readFile(output, { encoding: 'utf8' }, (err, data) => {
                if (err) {
                    d.reject(err);
                }

                const $    = cheerio.load(data);
                const html = $('body').html();
                this._html = processHTML(html);

                // Delete created .html and .css files
                fs.unlink(output);
                fs.unlink(stylesheet);

                d.resolve();
            });
        });

        return d.promise;
    }

    // Override parseChapters() to extract Table of Contents
    parseChapters() {
        logger.log('Parsing chapters...');

        this.chapters = [];
        this.titles   = [];

        const $ = cheerio.load(this._html);

        // Get TOC and remove from HTML
        const $toc = $('div.toc');
        $toc.remove();
        this._html = $.html();

        // Get list of titles
        const $tocList = $toc.children('ul.toc');

        this.chapters = this.parseList($tocList);

        // Flatten list of chapters
        this.chapters = _.chain(this.chapters)
            .map(chapter => [chapter].concat(chapter.getChildrenDeep()))
            .flatten(true)
            .value();

        // Generate chapters filenames
        this.chapters.forEach(chapter => chapter.generateFilename('md', this.prefixFilenames));

        // Create README from remaining HTML
        const readme = new Readme('md', this.documentTitle, this._projectFolder, this._html);
        readme.addTitleToContent();

        // Add to list of chapters
        this.chapters.unshift(readme);
        this.setTitlesId();
    }

    /**
     * Construct chapters tree based on TOC recursively
     *
     * @param  {jQuery Element} $ul     List element for the TOC
     * @param  {Number}         level   Current level for the chapters
     * @param  {Chapter}        parent  Chapter to use as parent of parsed chapters
     * @return {Array<Chapter>}
     */
    parseList($ul, level, parent) {
        // Initial values
        level  = level || 0;
        parent = parent || null;

        const chapters = [];

        const $ = cheerio.load(this._html);
        $ul.children('li').each((i, li) => {
            const $li      = $(li);
            const chapter  = new Chapter(this._projectFolder);
            chapter.level  = level;
            chapter.parent = parent;

            // Gather informations from TOC
            const info      = extractTOCTitleInfo($li);
            chapter.type    = info.type;
            chapter.titleId = info.titleId;
            chapter.title   = info.title;
            chapter.num     = chapters.length + 1;

            // Sub chapters
            const $sub       = $li.children('ul');
            chapter.children = this.parseList($sub, level + 1, chapter);

            // Get chapter HTML
            const selector  = getChapterSelector(chapter);
            chapter.content = this.extractHTML(selector);

            chapters.push(chapter);
        });

        // Set siblings
        chapters.map((chapter, index) => {
            if (index > 0) {
                chapter.previous = chapters[index - 1];
            }

            if ((index + 1) < chapters.length) {
                chapter.next = chapters[index + 1];
            }

            return chapter;
        });

        return chapters;
    }

    /**
     * Return the HTML for an HTML <selector>
     * and remove the corresponding element from DOM
     *
     * @param  {String} selector
     * @return {String}
     */
    extractHTML(selector) {
        const $           = cheerio.load(this._html);
        const $element    = $(selector);
        const elementHTML = $.html(selector);

        $element.remove();
        this._html = $.html();
        return elementHTML;
    }

    /**
     * Update chapters to set possible <section> tags ids
     * to their first header tag element to keep references
     * in generated markdown
     */
    setTitlesId() {
        // Pass <section> id to its first <h>
        this.chapters = this.chapters.map((chapter) => {
            const $ = cheerio.load(chapter.content);

            $('section').each((i, section) => {
                const sectionId = $(section).attr('id');
                // <section> not found
                if (!sectionId) {
                    return;
                }

                // Set <section> id to first nested header
                const $h = $(section).find(':header').first();
                if (!$h.attr('id')) {
                    $h.attr('id', sectionId);
                    $(section).removeAttr('id');
                }
            });

            chapter.content = $.html();
            return chapter;
        });
    }
}

/**
 * Return all the infos about a title
 * from an <li> TOC element
 *
 * @param  {jQuery Element} $li
 * @return {Object}
 */
function extractTOCTitleInfo($li) {
    const $span = $li.children('span');
    const $link = $span.children('a');

    return {
        type:    $span.attr('class'),
        titleId: utils.idFromRef($link.attr('href')),
        title:   $link.text()
    };
}

/**
 * Return a formatted selector from titleInfo
 *
 * @param  {Object} titleInfo
 * @return {String}
 */
function getChapterSelector(titleInfo) {
    return `*[id="${titleInfo.titleId}"]`;
}

/**
 * Replace DocBook specific HTML tags
 * to be rendered in markdown-compatible HTML
 *
 * @param  {String} html    Original HTML
 * @return {String}         Modified HTML
 */
function processHTML(html) {
    const $ = cheerio.load(html);

    // Docbook <literallayout> are converted as <div class=literallayout><p>...</p></div>
    // Use <pre><code>...</code></pre> instead
    $('.literallayout').each((i, el) => {
        const $code = $('<code></code>');
        $code.html($(el).find('p').first().html().trim());

        const $pre = $('<pre></pre>');
        $code.wrap($pre);
        $(el).replaceWith($pre);
    });

    // Convert <pre class="programlisting"> to <pre><code>...
    $('pre.programlisting, pre.screen').each((i, el) => {
        const $code = $('<code></code>');
        $code.html($(el).html());
        $(el).html('');
        $(el).append($code);
    });

    // Create a <h6> title for <example> tags
    $('div.example').each((i, el) => {
        // Get id and remove from parent
        const id = $(el).attr('id');
        $(el).removeAttr('id');

        // Create <h6> tag with id
        const $h6 = $('<h6></h6>');
        $h6.attr('id', id);

        // Replace <div> tag by <h6>
        const $divTitle = $(el).find('div.example-title');
        $h6.html($divTitle.html());

        $divTitle.replaceWith($h6);
    });

    // Format footnotes origins
    $('a.footnote, a.footnoteref').each((i, el) => {
        // Check link has only one child
        const $children = $(el).children();
        if (_.size($children) !== 1) {
            return;
        }

        // Check that child is a <sup>
        let $sup = $children.first();
        if (!$sup.is('sup')) {
            return;
        }

        // Make <sup> parent of <a>
        $sup.insertBefore($(el));
        // $(el).remove();

        $sup = $(el).prev();
        $(el).html($sup.html());

        $sup.text('');
        $sup.append($(el));
    });

    // Format footnotes
    $('div.footnote').each((i, el) => {
        // Get tags
        const $p   = $(el).find('p').first();
        const $a   = $(el).find('a').first();
        const $sup = $(el).find('sup').first();

        // Move <div> id to <sup>
        const id = $(el).attr('id');
        $sup.attr('id', id);
        $(el).removeAttr('id');

        // Remove <a> tag
        $a.remove();

        // Move <sup> at beginning of <p>
        $sup.html($sup.html() + $p.html());
        $p.html('');
        $p.prepend($sup);

        // Move <a> at the end of <sup> tag
        $a.html('&#8593;');
        $sup.append($a);
    });

    return $.html();
}

module.exports = DocbookConverter;
