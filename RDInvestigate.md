RD Protocol Model Architecture

  The Rider SDK exposes C# code intelligence through these key models, all accessible from a Project via the Solution bridge:

  Entry Point

  import com.jetbrains.rider.projectView.solution  // extension property
  val solution = project.solution  // Project → Solution

  Available Models
  
  ┌───────────┬────────────────────┬──────────────────────────────┬────────────────────────────────────────────────────────────────┐
  │  Feature  │       Model        │            Access            │                            Key API                             │
  ├───────────┼────────────────────┼──────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ Find      │                    │                              │ Reactive sessions map — backend pushes RdFindUsagesSession     │
  │ Usages    │ FindUsagesModel    │ solution.findUsagesHost      │ with RdUsageList containing RdUsageBase items (has fileId,     │
  │           │                    │                              │ startOffset, endOffset, text, referenceType)                   │
  ├───────────┼────────────────────┼──────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ Type      │ TypeHierarchyModel │ solution.typeHierarchyModel  │ Backend pushes RdTypeHierarchyTree with                        │
  │ Hierarchy │                    │                              │ RdTypeHierarchyTreeItem nodes                                  │
  ├───────────┼────────────────────┼──────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ Call      │                    │                              │ startNewSession(RdCallHierarchySessionStartArgs) →             │
  │ Hierarchy │ CallHierarchyModel │ solution.callHierarchyModel  │ RdCallHierarchySession with rootElement and getChildren(id) RD │
  │           │                    │                              │  call                                                          │
  ├───────────┼────────────────────┼──────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ Symbol    │ RadSymbolsModel    │ solution.radSymbolsModel     │ findSymbolsByName(String) → List<RadSymbolInfo(offset,         │
  │ Search    │                    │ (C++ only)                   │ filePath)>                                                     │
  └───────────┴────────────────────┴──────────────────────────────┴────────────────────────────────────────────────────────────────┘
  
  Key Challenge: The FindUsages Model is UI-Driven

  The FindUsagesModel works reactively — the backend pushes sessions into sessions map when the user (or an action) triggers Find
  Usages. There's no simple call(documentId, offset) → List<Usage> RPC. Instead, the flow is:

  1. An action (like FindUsages) dispatches to the backend via Rider's action system
  2. The backend pushes an RdFindUsagesSession into the sessions map
  3. The frontend observes the session and renders the tool window

  Practical Approaches (from most to least promising)

  1. Programmatic Action Invocation — Invoke FindUsages action via ActionManager, observe the FindUsagesModel.sessions map for the new
  session, collect RdUsageBase items from RdUsageList.items. Each usage has fileId (an RdDocumentId mapping to a Document/VirtualFile
  via FrontendDocumentHost), startOffset, endOffset, and text.

  2. Leverage existing platform APIs that Rider DOES support — Our current FindUsagesHandlerFactory EP and ReferencesSearch code may
  actually work if the C# PSI elements are properly resolved. The issue might be in element resolution (step before search), not the
  search itself. Rider registers FindUsagesHandlerFactory extensions for C# that can handle the search — we just need valid PsiElement
  inputs.

  3. Use GotoDeclarationHandler EP (already partially implemented) — Your PsiUtils.resolveViaGotoDeclarationHandlers() approach is
  sound for go-to-definition. For C#, Rider's handler delegates to the backend.

  Given the complexity of approach 1 and the fact that approach 2 might already work once element resolution is fixed, I'd recommend we
  first verify whether FindUsagesHandlerFactory and ReferencesSearch work when given a properly resolved C# PSI element. The problem
  might be upstream in findElementAtPosition / element resolution rather than in the search APIs themselves.

  Want me to proceed with verifying approach 2 (testing whether the existing search APIs work with proper C# element resolution), or
  dive into implementing approach 1 (the full RD protocol-based find usages)?