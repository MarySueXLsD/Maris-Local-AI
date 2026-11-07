import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationLanguage, detectLanguage, drifted, isContinuation } from '../src/shared/language.ts'

test('detects the writing system and the language', () => {
  assert.equal(detectLanguage('what scripts there are?')?.code, 'en')
  assert.equal(detectLanguage('create folder tree with 5 folders inside and in each randomly from 1 to 7 txt or py files')?.code, 'en')
  assert.equal(detectLanguage('напиши мне калькулятор на расте')?.code, 'ru')
  assert.equal(detectLanguage('Привіт, як справи? Що ти вмієш?')?.code, 'uk')
  assert.equal(detectLanguage('这个文件夹里有哪些脚本？')?.code, 'zh')
  assert.equal(detectLanguage('このフォルダにはどんなスクリプトがありますか')?.code, 'ja')
  assert.equal(detectLanguage('¿Qué scripts hay en esta carpeta y para qué sirven?')?.code, 'es')
  assert.equal(detectLanguage('Welche Skripte gibt es in diesem Ordner und was machen sie?')?.code, 'de')
  assert.equal(detectLanguage('Quels scripts y a-t-il dans ce dossier et que font-ils ?')?.code, 'fr')
})

test('code, paths and file names do not decide the language', () => {
  const l = detectLanguage('what does `設定ファイル.ps1` do in C:\\Users\\me\\ゲーム\\scripts?')
  assert.equal(l?.code, 'en')
  assert.equal(detectLanguage('```python\nprint("привет")\n```\nexplain this code please')?.code, 'en')
})

test('one or two shared words are not confident; the conversation decides', () => {
  assert.equal(detectLanguage('ok')?.confident, false)
  assert.equal(detectLanguage('continue')?.confident, false)
  assert.equal(conversationLanguage(['напиши скрипт, который удаляет пустые папки', 'ok'])?.code, 'ru')
  assert.equal(conversationLanguage(['list the files in my downloads folder please', 'continue'])?.code, 'en')
  assert.equal(conversationLanguage([]), undefined)
})

test('an answer that slid into another writing system is caught', () => {
  const en = detectLanguage('what scripts there are?')!
  assert.equal(drifted(en, '根据您提供的文件列表，这是一个名为 Drive Club 的安装目录。其中包含了大量的第三方库'), true)
  assert.equal(drifted(en, 'The folder has three scripts: FFB Tuner.ps1, a launcher and an installer.'), false)
  // A few kanji in an English answer about Japanese file names are fine.
  assert.equal(drifted(en, 'There are two scripts. One is named 設定 (settings) and the other one starts the game for you.'), false)
  const ru = detectLanguage('какие тут есть скрипты?')!
  assert.equal(drifted(ru, 'В папке три скрипта: FFB Tuner.ps1, лаунчер и установщик. Первый настраивает отдачу руля.'), false)
  assert.equal(drifted(ru, 'There are three scripts in this folder. The first one tunes the force feedback of your wheel, the second one starts the game, and the third one installs it.'), true)
})

test('continuations keep the task going', () => {
  for (const t of ['continue', 'Continue.', 'go on', 'keep going!', 'продолжай', 'yes', 'ok', 'please continue']) assert.equal(isContinuation(t), true, t)
  for (const t of ['continue with the tests but skip the slow ones', 'what is this?', 'create a folder']) assert.equal(isContinuation(t), false, t)
})
