import * as ts from "typescript"
import * as path from "path"
import { emptyDir, readdir, readFile, readJson, writeFile } from "fs-extra-p"
import { JsDocRenderer } from "./JsDocRenderer"
import { checkErrors, processTree } from "./util"
import { Class, Descriptor, Member, MethodDescriptor, Property, SourceFileDescriptor, SourceFileModuleInfo, Type, Variable } from "./psi"
import BluebirdPromise from "bluebird-lst"

export interface TsToJsdocOptions {
  readonly out: string
  readonly externalIfNotMain?: string | null
  
  /**
   * The path to examples dir.
   */
  readonly examples?: string | null
}

const vm = require("vm")

export async function generateAndWrite(basePath: string, config: ts.ParsedCommandLine, tsConfig: any) {
  let packageData: any = {name: "packageJsonNotDefined"}
  try {
    packageData = await readJson(path.join(basePath, "package.json"))
  }
  catch (e) {
  }

  const generator = generate(basePath, config, packageData.name, packageData == null ? null : packageData.main)

  const options: TsToJsdocOptions = typeof tsConfig.jsdoc === "string" ? {out: tsConfig.jsdoc} : tsConfig.jsdoc
  if (options.out == null) {
    throw new Error("Please specify out in the tsConfig.jsdoc (https://github.com/develar/ts2jsdoc#generate-jsdoc-from-typescript)")
  }

  const out = path.resolve(basePath, options.out)
  console.log(`Generating JSDoc to ${out}`)
  await emptyDir(out)

  const moduleNameToResult = generator.moduleNameToResult
  const mainModuleName = generator.moduleName
  const mainPsi = generator.moduleNameToResult.get(mainModuleName)
  
  const oldModulePathToNew = new Map<string, string>()
  for (const [id, names] of generator.mainMappings) {
    const psi = moduleNameToResult.get(id)
    for (const name of names) {
      if (moveMember(psi.classes, mainPsi.classes, name, mainModuleName)) {
        oldModulePathToNew.set(`module:${id}.${name}`, `module:${mainModuleName}.${name}`)
        continue
      }
      
      moveMember(psi.functions, mainPsi.functions, name) || moveMember(psi.members, mainPsi.members, name)
    }
  }
  
  const exampleDir = options.examples == null ? null : path.resolve(basePath, options.examples)
  const existingClassExampleDirs = exampleDir == null ? null : new Set((await readdir(exampleDir)).filter(it => it[0] != "." && !it.includes(".")))
  
  for (const [moduleId, psi] of moduleNameToResult.entries()) {
    const modulePathMapper: ModulePathMapper = oldPath => {
      if (!oldPath.startsWith("module:")) {
        return oldPath
      }
      
      let result = oldModulePathToNew.get(oldPath)
      if (result != null) {
        return result
      }
      
      if (moduleId === mainModuleName && options.externalIfNotMain != null) {
        // external:electron-builder/out/platformPackager.PlatformPackager is not rendered by jsdoc2md,
        // only PlatformPackager
        const dotIndex = oldPath.lastIndexOf(".")
        const value = oldPath.substring(dotIndex + 1)
        externalToModuleName.set(value, oldPath.substring(oldPath.indexOf(":") + 1, dotIndex))
        return `external:${value}`
      }
      
      return oldPath
    }
    
    let result = ""
    const externalToModuleName = new Map<string, string>()
    for (const d of copyAndSort(psi.members)) {
      if ((<any>d).kind == null) {
        result += generator.renderer.renderVariable(<Variable>d, modulePathMapper)
      }
      else {
        result += generator.renderer.renderMember(<Descriptor>d)
      }
    }
    
    for (const d of copyAndSort(psi.classes)) {
      let examples: Array<Example> = []
      if (existingClassExampleDirs != null && existingClassExampleDirs.has(d.name)) {
        const dir = path.join(exampleDir, d.name)
        examples = await BluebirdPromise.map((await readdir(dir)).filter(it => it[0] != "." && it.includes(".")), async it => {
          const ext = path.extname(it)
          return <Example>{
            name: path.basename(it, ext),
            content: await readFile(path.join(dir, it), "utf8"),
            lang: ext
          }
        })
      }
      
      result += generator.renderer.renderClassOrInterface(d, modulePathMapper, examples)
    }
    
    for (const d of copyAndSort(psi.functions)) {
      result += generator.renderer.renderMethod(d, modulePathMapper, null)
    }
    
    if (result === "") {
      continue
    }
    
    let externalJsDoc = ""
    for (const [external, moduleId] of externalToModuleName) {
      externalJsDoc += `/**\n* @external ${external}\n* @see ${options.externalIfNotMain}#module_${moduleId}.${external}\n*/\n`
    }

    await writeFile(path.join(out, moduleId.replace(/\//g, "-") + ".js"), `${externalJsDoc}/** 
 * @module ${moduleId}
 */

${result}`)
  }
}

export type ModulePathMapper = (oldPath: string) => string

function moveMember<T extends Member>(members: Array<T>, mainPsiMembers: Array<T>, name: string, newId: string | null = null): boolean {
  const index = members.findIndex(it => it.name === name)
  if (index < 0) {
    return false
  }
  
  const member = members[index]
  if (newId != null) {
    (<any>member).modulePath = "module:" + newId
  }

  mainPsiMembers.push(member)
  members.splice(index, 1)
  return true
}

function copyAndSort<T extends Member>(members: Array<T>): Array<T> {
  return members.slice().sort((a, b) => a.name.localeCompare(b.name))
}

export function generate(basePath: string, config: ts.ParsedCommandLine, moduleName: string, main: string | null): JsDocGenerator {
  const compilerOptions = config.options
  const compilerHost = ts.createCompilerHost(compilerOptions)
  const program = ts.createProgram(config.fileNames, compilerOptions, compilerHost)
  checkErrors(ts.getPreEmitDiagnostics(program))

  const compilerOutDir = compilerOptions.outDir
  if (compilerOutDir == null) {
    throw new Error("outDir is not specified in the compilerOptions")
  }

  const generator = new JsDocGenerator(program, path.relative(basePath, compilerOptions.outDir), moduleName, main, (<any>program).getCommonSourceDirectory())
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      generator.generate(sourceFile)
    }
  }
  return generator
}

export class JsDocGenerator {
  private readonly fileNameToModuleId: any = {}
  readonly moduleNameToResult = new Map<string, SourceFileDescriptor>()

  private currentSourceModuleId: string
  readonly renderer = new JsDocRenderer(this)
  
  readonly mainMappings = new Map<string, Array<string>>() 

  constructor(readonly program: ts.Program, readonly relativeOutDir: string, readonly moduleName: string, private readonly mainFile: string, private readonly commonSourceDirectory: string) {
  }

  private sourceFileToModuleId(sourceFile: ts.SourceFile): SourceFileModuleInfo {
    if (sourceFile.isDeclarationFile) {
      if (sourceFile.fileName.endsWith("node.d.ts")) {
        return {id: "node", fileNameWithoutExt: "", isMain: false}
      }
    }

    let sourceModuleId: string
    const fileNameWithoutExt = sourceFile.fileName.slice(0, sourceFile.fileName.lastIndexOf(".")).replace(/\\/g, "/")
    const name = path.relative(this.commonSourceDirectory, fileNameWithoutExt)
    if (this.moduleName != null) {
      sourceModuleId = this.moduleName
      if (name !== "index") {
        sourceModuleId += "/" + this.relativeOutDir
      }
    }
    else {
      sourceModuleId = this.relativeOutDir
    }

    if (name !== "index") {
      sourceModuleId += "/" + name
    }

    const isMain = this.mainFile == null ? fileNameWithoutExt.endsWith("/main") : `${fileNameWithoutExt}.js`.includes(path.posix.relative(this.relativeOutDir, this.mainFile))
    if (isMain) {
      sourceModuleId = this.moduleName
    }
    return {id: sourceModuleId, fileNameWithoutExt, isMain}
  }

  generate(sourceFile: ts.SourceFile): void {
    if (sourceFile.text.length === 0) {
      return
    }

    const moduleId = this.sourceFileToModuleId(sourceFile)
    this.currentSourceModuleId = moduleId.id
    this.fileNameToModuleId[path.resolve(moduleId.fileNameWithoutExt).replace(/\\/g, "/")] = moduleId.id

    const classes: Array<Class> = []
    const functions: Array<MethodDescriptor> = []
    const members: Array<Variable | Descriptor> = []

    processTree(sourceFile, (node) => {
      if (node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.ClassDeclaration) {
        const descriptor = this.processClassOrInterface(node)
        if (descriptor != null) {
          classes.push(descriptor)
        }
      }
      else if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
        const descriptor = this.describeFunction(<ts.FunctionDeclaration>node)
        if (descriptor != null) {
          functions.push(descriptor)
        }
      }
      else if (moduleId.isMain && node.kind === ts.SyntaxKind.ExportDeclaration) {
        this.handleExportFromMain(<ts.ExportDeclaration>node)
        return true
      }
      else if (node.kind === ts.SyntaxKind.SourceFile) {
        return false
      }
      else if (node.kind === ts.SyntaxKind.VariableStatement) {
        const descriptor = this.describeVariable(<ts.VariableStatement>node)
        if (descriptor != null) {
          members.push(descriptor)
        }
      }
      else if (node.kind === ts.SyntaxKind.EnumDeclaration) {
        const descriptor = this.describeEnum(<ts.EnumDeclaration>node)
        if (descriptor != null) {
          members.push(descriptor)
        }
      }
      return true
    })

    const existingPsi = this.moduleNameToResult.get(moduleId.id)
    if (existingPsi == null) {
      this.moduleNameToResult.set(moduleId.id, {classes, functions, members})
    }
    else {
      existingPsi.classes.push(...classes)
      existingPsi.functions.push(...functions)
      existingPsi.members.push(...members)
    }
  }
  
  private handleExportFromMain(node: ts.ExportDeclaration) {
    const moduleSpecifier = node.moduleSpecifier
    const exportClause = node.exportClause
    if (exportClause == null || moduleSpecifier == null) {
      return
    }
    
    if (moduleSpecifier.kind !== ts.SyntaxKind.StringLiteral) {
      return
    }
    
    const filePath = (<ts.StringLiteral>moduleSpecifier).text
    if (!filePath.startsWith(".")) {
      return
    }
    
    const fullFilename = path.posix.resolve(path.posix.dirname(node.getSourceFile().fileName), filePath) + ".ts"
    const sourceFile = this.program.getSourceFile(fullFilename)
    if (sourceFile == null) {
      return
    }
    
    const names: Array<string> = []
    for (const e of exportClause.elements) {
      if (e.kind === ts.SyntaxKind.ExportSpecifier) {
        names.push((<ts.Identifier>(<ts.ExportSpecifier>e).name).text) 
      }
      else {
        console.error(`Unsupported export element: ${e.getText(e.getSourceFile())}`)
      }
    }
    
    this.mainMappings.set(this.sourceFileToModuleId(sourceFile).id, names)
  }

  getTypeNamePathByNode(node: ts.Node): Array<string | Type> | null {
    if (node.kind === ts.SyntaxKind.UnionType) {
      return this.typesToList((<ts.UnionType>(<any>node)).types, node)
    }
    else if (node.kind === ts.SyntaxKind.FunctionType) {
      return ["callback"]
    }
    else if (node.kind === ts.SyntaxKind.NumberKeyword) {
      return ["number"]
    }
    else if (node.kind === ts.SyntaxKind.StringKeyword) {
      return ["string"]
    }
    else if (node.kind === ts.SyntaxKind.BooleanKeyword) {
      return ["boolean"]
    }
    else if (node.kind === ts.SyntaxKind.NullKeyword) {
      return ["null"]
    }
    else if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
      return ["undefined"]
    }
    else if (node.kind === ts.SyntaxKind.LiteralType) {
      const text = (<ts.LiteralLikeNode>(<any>(<ts.LiteralTypeNode>node).literal)).text
      return [`"${text}"`]
    }
    else if (node.kind === ts.SyntaxKind.TypeLiteral) {
      // todo
      return ['Object.<string, any>']
    }

    const type = this.program.getTypeChecker().getTypeAtLocation(node)
    return type == null ? null : this.getTypeNames(type, node)
  }

  private typesToList(types: Array<ts.Type>, node: ts.Node) {
    const typeNames: Array<string | Type> = []
    for (const type of types) {
      const name = (<any>type).kind == null ? [this.getTypeNamePath(<any>type)] : this.getTypeNamePathByNode(<any>type)
      if (name == null) {
        throw new Error("cannot get name for " + node.getText(node.getSourceFile()))
      }
      typeNames.push(...name)
    }
    return typeNames
  }

  getTypeNames(type: ts.Type, node: ts.Node): Array<string | Type> | null {
    if (type.flags & ts.TypeFlags.UnionOrIntersection && !(type.flags & ts.TypeFlags.Enum) && !(type.flags & ts.TypeFlags.Boolean)) {
      return this.typesToList((<ts.UnionOrIntersectionType>type).types, node)
    }

    let result = this.getTypeNamePath(type)
    if (result == null) {
      throw new Error("Cannot infer getTypeNamePath")
    }

    const typeArguments = (<ts.TypeReference>type).typeArguments
    if (typeArguments != null) {
      const subTypes = []
      for (const type of typeArguments) {
        subTypes.push(...this.getTypeNames(type, node))
      }
      return [{name: result, subTypes: subTypes}]
    }
    return [result]
  }

  getTypeNamePath(type: ts.Type): string | null {
    if (type.flags & ts.TypeFlags.Boolean) {
      return "boolean"
    }
    if (type.flags & ts.TypeFlags.Void) {
      return "void"
    }
    if (type.flags & ts.TypeFlags.Null) {
      return "null"
    }
    if (type.flags & ts.TypeFlags.String) {
      return "string"
    }
    if (type.flags & ts.TypeFlags.Number) {
      return "number"
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return "undefined"
    }
    if (type.flags & ts.TypeFlags.Any) {
      return "any"
    }
    if (type.flags & ts.TypeFlags.Literal) {
      return `"${(<ts.LiteralType>type).text}"`
    }

    const symbol = type.symbol
    if (symbol == null || symbol.declarations == null || symbol.declarations.length === 0) {
      return null
    }

    const valueDeclaration = symbol.valueDeclaration || ((symbol.declarations == null || symbol.declarations.length === 0) ? null : symbol.declarations[0])
    if (ts.getCombinedModifierFlags(valueDeclaration) & ts.ModifierFlags.Ambient) {
      // Error from lib.es5.d.ts
      return symbol.name
    }

    let typeSourceParent: ts.Node = valueDeclaration
    while (typeSourceParent != null) {
      if (typeSourceParent.kind === ts.SyntaxKind.ModuleDeclaration && (typeSourceParent.flags & ts.NodeFlags.NestedNamespace) <= 0) {
        const m = <ts.ModuleDeclaration>typeSourceParent
        const sourceModuleId = (<ts.Identifier>m.name).text
        if (typeSourceParent.flags & ts.NodeFlags.Namespace) {
          return `${sourceModuleId}:${symbol.name}`
        }
        else {
          return `module:${sourceModuleId}.${symbol.name}`
        }
      }
      else if (typeSourceParent.kind === ts.SyntaxKind.SourceFile) {
        const sourceModuleId = this.sourceFileToModuleId(<ts.SourceFile>typeSourceParent).id
        return `module:${sourceModuleId}.${symbol.name}`
      }

      typeSourceParent = typeSourceParent.parent
    }

    console.warn(`Cannot find parent for ${symbol}`)
    return null
  }
  
  private describeEnum(node: ts.EnumDeclaration): Descriptor {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }
    
    const type = {
      names: ["number"]
    }
    
    const name = (<ts.Identifier>node.name).text
    const moduleId = this.computeTypePath()
    const id = `${moduleId}.${name}`
    
    const properties: Array<Descriptor> = []
    for (const member of node.members) {
      const name = (<ts.Identifier>member.name).text
      properties.push({
        name: name,
        kind: "member",
        scope: "static",
        memberof: id,
        type: type,
      })
    }

    // we don't set readonly because it is clear that enum is not mutable
    // e.g. jsdoc2md wil add useless "Read only: true"
    return {
      node: node,
      id: id,
      name: name,
      longname: id,
      kind: "enum",
      scope: "static",
      memberof: moduleId,
      type: type,
      properties: properties,
    }
  }

  private describeVariable(node: ts.VariableStatement): Variable {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const declarations = node.declarationList == null ? null : node.declarationList.declarations
    if (declarations == null && declarations.length !== 1) {
      return null
    }

    const declaration = <ts.VariableDeclaration>declarations[0]
    if (declaration.type == null) {
      return null
    }

    let types
    const type = this.program.getTypeChecker().getTypeAtLocation(declaration)
    if (type.symbol != null && type.symbol.valueDeclaration != null) {
      types = [this.getTypeNamePath(type)]
    }
    else {
      types = this.getTypeNamePathByNode(declaration.type)
    }

    // NodeFlags.Const on VariableDeclarationList, not on VariableDeclaration
    return {types, node, name: (<ts.Identifier>declaration.name).text, isConst: (node.declarationList.flags & ts.NodeFlags.Const) > 0}
  }

  //noinspection JSMethodCanBeStatic
  private describeFunction(node: ts.FunctionDeclaration): MethodDescriptor | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }
    return {name: (<ts.Identifier>node.name).text, node: node, tags: []}
  }

  private processClassOrInterface(node: ts.Node): Class | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const nodeDeclaration = <ts.InterfaceDeclaration>node
    const className = (<ts.Identifier>nodeDeclaration.name).text

    const clazz = <ts.ClassDeclaration>node
    let parents: Array<string | Type> = []
    if (clazz.heritageClauses != null) {
      for (const heritageClause of clazz.heritageClauses) {
        if (heritageClause.types != null) {
          for (const type of heritageClause.types) {
            const typeNamePath = this.getTypeNamePathByNode(type)
            if (typeNamePath != null) {
              parents = typeNamePath
            }
          }
        }
      }
    }

    const methods: Array<MethodDescriptor> = []
    const properties: Array<Property> = []
    for (const member of nodeDeclaration.members) {
      if (member.kind === ts.SyntaxKind.PropertySignature) {
        const p = this.describeProperty(<any>member, node.kind === ts.SyntaxKind.ClassDeclaration)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
        const p = this.describeProperty(<any>member, node.kind === ts.SyntaxKind.ClassDeclaration)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.MethodDeclaration || member.kind === ts.SyntaxKind.MethodSignature) {
        const m = this.renderMethod(<any>member, className)
        if (m != null) {
          methods.push(m)
        }
      }
    }

    methods.sort((a, b) => {
      let weightA = a.isProtected ? 100 : 0
      let weightB = b.isProtected ? 100 : 0

      // do not reorder getFeedURL/setFeedURL
      weightA += trimMutatorPrefix(a.name).localeCompare(trimMutatorPrefix(b.name))
      return weightA - weightB
    })

    return {
      modulePath: this.computeTypePath(),
      name: className,
      node, methods, properties, parents,
      isInterface: node.kind === ts.SyntaxKind.InterfaceDeclaration
    }
  }

  private describeProperty(node: ts.PropertySignature | ts.PropertyDeclaration, isParentClass: boolean): Property | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }

    const name = (<ts.Identifier>node.name).text
    
    let types
    if (node.type == null) {
      const type = this.program.getTypeChecker().getTypeAtLocation(node)
      types = type == null ? null : this.getTypeNames(type, node)
    }
    else {
      types = this.getTypeNamePathByNode(node.type)
    }

    let isOptional = node.questionToken != null
    let defaultValue = null
    const initializer = node.initializer
    if (initializer != null) {
      if ((<any>initializer).expression != null || (<ts.Node>initializer).kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        defaultValue = initializer.getText()
      }
      else {
        try {
          const sandbox = {sandboxvar: null as any}
          vm.runInNewContext(`sandboxvar=${initializer.getText()}`, sandbox)

          const val = sandbox.sandboxvar
          if (val === null || typeof val === "string" || typeof val === "number" || "boolean" || Object.prototype.toString.call(val) === "[object Array]") {
            defaultValue = val
          }
          else if (val) {
            console.warn(`unknown initializer for property ${name}: ${val}`)
          }
        }
        catch (e) {
          console.info(`exception evaluating initializer for property ${name}`)
          defaultValue = initializer.getText()
        }
      }
    }

    isOptional = isOptional || defaultValue != null || types.includes("null")
    if (!isOptional && isParentClass && (flags & ts.ModifierFlags.Readonly) > 0) {
      isOptional = true
    }
    return {name, types, node, isOptional: isOptional, defaultValue}
  }

  private renderMethod(node: ts.SignatureDeclaration, className: string): MethodDescriptor | null {
    // node.flags doesn't report correctly for private methods
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }

    const tags = []

    const isProtected = (flags & ts.ModifierFlags.Protected) > 0
    if (isProtected) {
      tags.push(`@protected`)
    }

    const name = (<ts.Identifier>node.name).text
    return {name, tags, isProtected, node}
  }

  private computeTypePath(): string {
    return "module:" + this.currentSourceModuleId
  }
}

function trimMutatorPrefix(name: string) {
  if (name.length > 4 && name[3] === name[3].toUpperCase() && (name.startsWith("get") || name.startsWith("set"))) {
    return name[3].toLowerCase() + name.substring(4)
  }
  return name
}

export interface Example {
  name: string
  content: string
  lang: string
}