import crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import Mustache from 'mustache';
import {
	Editor,
	FileSystemAdapter,
	MarkdownView,
	Notice,
	parseYaml,
	Plugin
} from 'obsidian';
import * as path from 'path';
import {
	EmbedInfo,
	HTMLTemplate,
	MarkdownTemplate,
	REGEX,
	SPINNER,
} from './constants';
import { ExEditor, Selected } from './exEditor';
import { parsers } from './parser';
import type { ObsidianLinkEmbedPluginSettings } from './settings';
import { DEFAULT_SETTINGS, ObsidianLinkEmbedSettingTab } from './settings';
import EmbedSuggest from './suggest';
import ImageDownloader from 'utils/image-downloader';

interface PasteInfo {
	trigger: boolean;
	text: string;
}

export default class ObsidianLinkEmbedPlugin extends Plugin {
	settings: ObsidianLinkEmbedPluginSettings;
	pasteInfo: PasteInfo;

	async getText(editor: Editor): Promise<Selected> {
		let selected = ExEditor.getSelectedText(editor, this.settings.debug);
		let cursor = editor.getCursor();
		if (!selected.can) {
			selected.text = await navigator.clipboard.readText();
			selected.boundary = {
				start: cursor,
				end: cursor,
			};
		}
		return selected;
	}

	async onload() {
		await this.loadSettings();

		this.pasteInfo = {
			trigger: false,
			text: '',
		};

		this.registerEvent(
			this.app.workspace.on(
				'editor-paste',
				(
					evt: ClipboardEvent,
					editor: Editor,
					markdownView: MarkdownView,
				) => {
					this.pasteInfo = {
						trigger: false,
						text: '',
					};
					const text = evt.clipboardData.getData('text/plain');
					if (ObsidianLinkEmbedPlugin.isUrl(text)) {
						this.pasteInfo.trigger = true;
						this.pasteInfo.text = text;
					}
				},
			),
		);

		this.registerEditorSuggest(new EmbedSuggest(this.app, this));

		this.addCommand({
			id: 'embed-link',
			name: 'Embed link',
			editorCallback: async (editor: Editor) => {
				let selected = await this.getText(editor);
				if (!this.checkUrlValid(selected)) {
					return;
				}
				await this.embedUrl(editor, selected, [
					this.settings.primary,
					this.settings.backup,
				]);
			},
		});
		Object.keys(parsers).forEach((name) => {
			this.addCommand({
				id: `embed-link-${name}`,
				name: `Embed link with ${name}`,
				editorCallback: async (editor: Editor) => {
					let selected = await this.getText(editor);
					if (!this.checkUrlValid(selected)) {
						return;
					}
					await this.embedUrl(editor, selected, [name]);
				},
			});
		});

		this.registerMarkdownCodeBlockProcessor('embed', (source, el, ctx) => {
			const info = parseYaml(source.trim()) as EmbedInfo;
			const html = HTMLTemplate.replace(/{{title}}/gm, info.title)
				.replace(/{{{image}}}/gm, info.image)
				.replace(/{{description}}/gm, info.description)
				.replace(/{{{url}}}/gm, info.url);
			let parser = new DOMParser();
			var doc = parser.parseFromString(html, 'text/html');
			el.replaceWith(doc.body.firstChild);
		});

		this.addSettingTab(new ObsidianLinkEmbedSettingTab(this.app, this));
	}

	onunload() { }

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	checkUrlValid(selected: Selected): boolean {
		if (
			!(
				selected.text.length > 0 &&
				ObsidianLinkEmbedPlugin.isUrl(selected.text)
			)
		) {
			new Notice('Need a link to convert to embed.');
			return false;
		}
		return true;
	}

	getVaultPath() {
		let adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return '';
	}

	async embedUrl(
		editor: Editor,
		selected: Selected,
		selectedParsers: string[],
		inPlace: boolean = this.settings.inPlace,
	) {
		let url = selected.text;
		// Replace selection if in place
		if (selected.can && inPlace) {
			editor.replaceRange(
				'',
				selected.boundary.start,
				selected.boundary.end,
			);
		}

		// Put a dummy preview here first
		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		let template = MarkdownTemplate;
		let newLine = false;
		if (lineText.length > 0) {
			newLine = true;
		}
		if (newLine) {
			editor.setCursor({ line: cursor.line + 1, ch: 0 });
		} else {
			editor.setCursor({ line: cursor.line, ch: lineText.length });
		}
		const startCursor = editor.getCursor();
		const dummyEmbed =
			Mustache.render(template, {
				title: 'Fetching',
				image: SPINNER,
				description: `Fetching ${url}`,
				url: url,
			}) + '\n';
		editor.replaceSelection(dummyEmbed);
		const endCursor = editor.getCursor();

		// Fetch image and handle local storage
		let idx = 0;
		while (idx < selectedParsers.length) {
			const selectedParser = selectedParsers[idx];
			if (this.settings.debug) {
				console.log('Link Embed: parser', selectedParser);
			}
			const parser = parsers[selectedParser];
			parser.debug = this.settings.debug;
			try {
				const data = await parser.parse(url);
				if (this.settings.debug) {
					console.log('Link Embed: meta data', data);
				}

				// Download the image to the vault

				try {
					const imageUrl = data.image;
					const finalPath = `${this.getVaultPath()}/attachments/`; // Final desired path

					const tempPath = path.join(`${this.getVaultPath()}/attachments/`, 'temp_image'); // Temporary path (this can be anything)
      				const imageDownloader = new ImageDownloader(tempPath)
					const imageName = await imageDownloader.downloadImage(imageUrl, finalPath);

					const localUrl = `http://localhost:8181/${imageName}`;

					// Prepare the escaped data
					const escapedData = {
						title: data.title.replace(/"/g, '\\"'),
						image: localUrl,  // Use local URL for image
						description: data.description.replace(/"/g, '\\"'),
						url: data.url,
					};

					// Render the final embed
					const embed = Mustache.render(template, escapedData) + '\n';
					if (this.settings.delay > 0) {
						await new Promise((f) =>
							setTimeout(f, this.settings.delay),
						);
					}

					// Before replacing, check whether the dummy preview is deleted or modified
					const dummy = editor.getRange(startCursor, endCursor);
					if (dummy == dummyEmbed) {
						editor.replaceRange(embed, startCursor, endCursor);
					} else {
						new Notice(
							`Dummy preview has been deleted or modified. Replacing is cancelled.`,
						);
					}
					break;
				} catch (error) {
					console.log('Link Embed: error', error);
					idx += 1;
					if (idx === selectedParsers.length) {
						this.errorNotice();
					}
				}
			} catch (error) {
				new Notice(error);
				console.log(error);
				return;
			}

		}
	}

	/**
	 * Generates a SHA-512 hash of a file's contents.
	 *
	 * @param filePath - The path to the file.
	 * @returns A Promise that resolves to the SHA-512 hash string.
	 */
	async computeFileHash(filePath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const hash = crypto.createHash('sha512');
			const stream = fs.createReadStream(filePath);

			stream.on('data', (chunk) => hash.update(chunk));
			stream.on('end', () => resolve(hash.digest('hex')));
			stream.on('error', (err) => reject(err));
		});
	}

	// Helper function to download the image and save it to the vault attachments folder
	async downloadImage(url: string, tempPath: string, finalPath: string): Promise<string> {
		console.log('tempPath', tempPath);

		return new Promise((resolve, reject) => {
			https.get(url, (response) => {
				console.log('response', response);
				// Get the file extension from the Content-Type header (e.g., image/jpeg or image/png)
				const contentType = response.headers['content-type'];
				const extension = contentType ? contentType.split('/')[1] : 'jpg';  // Default to jpg if not found
				console.log('extension', extension);

				// Create a temporary file stream to download the image
				const tempFile = fs.createWriteStream(tempPath);

				response.pipe(tempFile);
				tempFile.on('finish', async () => {
					tempFile.close(async () => {
						console.log(`Image downloaded to temporary path: ${tempPath}`);

						// Generate the final file name using the current timestamp and the file extension
						const fileHash = await this.computeFileHash(tempPath);
						const finalFileName = `${fileHash}.${extension}`;
						console.log('finalFileName', finalFileName);

						// Define the final path with the generated name
						const finalFilePath = path.join(finalPath, finalFileName);
						console.log('finalFilePath', finalFilePath);

						// Ensure that the final directory exists
						fs.mkdir(path.dirname(finalFilePath), { recursive: true }, (err) => {
							if (err) {
								console.error('Error creating directory:', err);
								reject(err);
							} else {
								// Check if image exists locally, if not, rename and save it
								fs.copyFile(tempPath, finalFilePath, (err) => {
									if (err) {
										console.error('Error renaming the file:', err);
										reject(err);
									} else {
										console.log(`Image renamed and saved to: ${finalFilePath}`);
										resolve(finalFileName); // Return just the filename
									}
								});
							}
						});
					});
				});
			}).on('error', (err) => {
				fs.unlink(tempPath, () => { }); // delete the file if there's an error
				reject(err);
			});
		});
	}

	public static isUrl(text: string): boolean {
		const urlRegex = new RegExp(REGEX.URL, 'g');
		return urlRegex.test(text);
	}

	errorNotice() {
		if (this.settings.debug) {
			console.log('Link Embed: Failed to fetch data');
		}
		new Notice(`Failed to fetch data`);
	}
}
