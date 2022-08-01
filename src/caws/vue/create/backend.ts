/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { WorkspaceSettings } from '../../commands'
import { VueWebview } from '../../../webviews/main'
import { Prompter } from '../../../shared/ui/prompter'
import { isValidResponse } from '../../../shared/wizards/wizard'
import {
    createAliasPrompter,
    createInstancePrompter,
    createStoragePrompter,
    createTimeoutPrompter,
    getAllInstanceDescriptions,
} from '../../wizards/workspaceSettings'
import { showViewLogsMessage } from '../../../shared/utilities/messages'
import { CawsBranch, CawsProject, ConnectedCawsClient } from '../../../shared/clients/cawsClient'
import { cloneToWorkspace, DevelopmentWorkspaceId, openDevelopmentWorkspace } from '../../model'
import { selectCawsResource } from '../../wizards/selectResource'
import { CancellationError } from '../../../shared/utilities/timeoutUtils'

interface LinkedResponse {
    readonly type: 'linked'
    readonly selectedProject: CawsProject
    readonly selectedBranch: CawsBranch
}

interface CloneResponse {
    readonly type: 'clone'
    readonly repositoryUrl: string
}

interface EmptyResponse {
    readonly type: 'empty'
}

export type SourceResponse = LinkedResponse | CloneResponse | EmptyResponse

export class CawsCreateWebview extends VueWebview {
    public readonly id = 'createCaws'
    public readonly source = 'src/caws/vue/create/index.js'

    public constructor(private readonly client: ConnectedCawsClient) {
        super()
    }

    public close() {
        this.dispose()
    }

    public async getProjects() {
        return this.client.listResources('project').flatten().promise()
    }

    public async getBranches(project: CawsProject) {
        const repos = this.client
            .listSourceRepositories({
                organizationName: project.org.name,
                projectName: project.name,
            })
            .flatten()

        const branches = repos.map(r =>
            this.client
                .listBranches({
                    organizationName: r.org.name,
                    projectName: r.project.name,
                    sourceRepositoryName: r.name,
                })
                .flatten()
                .promise()
        )

        return branches.flatten().promise()
    }

    public getAllInstanceDescriptions() {
        return getAllInstanceDescriptions()
    }

    public async showLogsMessage(title: string): Promise<string | undefined> {
        return showViewLogsMessage(title)
    }

    public async editSetting(settings: WorkspaceSettings, key: keyof WorkspaceSettings): Promise<WorkspaceSettings> {
        async function prompt(prompter: Prompter<any>) {
            prompter.recentItem = settings[key]
            const response = await prompter.prompt()

            if (isValidResponse(response)) {
                return { ...settings, [key]: response }
            } else {
                return settings
            }
        }

        switch (key) {
            case 'alias':
                return prompt(createAliasPrompter())
            case 'instanceType':
                return prompt(createInstancePrompter())
            case 'inactivityTimeoutMinutes':
                return prompt(createTimeoutPrompter())
            case 'persistentStorage':
                return prompt(createStoragePrompter())
        }
    }

    public async submit(settings: WorkspaceSettings, source: SourceResponse) {
        const workspace: DevelopmentWorkspaceId = await (() => {
            switch (source.type) {
                case 'empty':
                    return this.createEmptyWorkpace(settings, source)
                case 'linked':
                    return this.createLinkedWorkspace(settings, source)
                case 'clone':
                    return this.cloneRepository(settings, source)
            }
        })()

        return openDevelopmentWorkspace(this.client, workspace)
    }

    private async createEmptyWorkpace(settings: WorkspaceSettings, source: EmptyResponse) {
        const project = await selectCawsResource(this.client, 'project')
        if (!project) {
            throw new CancellationError('user')
        }

        return this.client.createDevelopmentWorkspace({
            ides: [{ name: 'VSCode' }],
            projectName: project.name,
            organizationName: project.org.name,
            ...settings,
        })
    }

    private createLinkedWorkspace(settings: WorkspaceSettings, source: LinkedResponse) {
        return this.client.createDevelopmentWorkspace({
            ides: [{ name: 'VSCode' }],
            projectName: source.selectedProject.name,
            organizationName: source.selectedProject.org.name,
            repositories: [
                {
                    repositoryName: source.selectedBranch.repo.name,
                    branchName: source.selectedBranch.name.replace('refs/heads/', ''),
                },
            ],
            ...settings,
        })
    }

    private async cloneRepository(settings: WorkspaceSettings, source: CloneResponse) {
        const isSchemeless = /^[\w]+@/.test(source.repositoryUrl)
        const withScheme = isSchemeless ? `ssh://${source.repositoryUrl}` : source.repositoryUrl
        const repoUri = vscode.Uri.parse(withScheme, true)
        const repoName = repoUri.path
            .split('/')
            .pop()
            ?.replace(/\.git$/, '')

        if (!repoName) {
            throw new TypeError('No repository name found')
        }

        const org = await selectCawsResource(this.client, 'org')
        if (!org) {
            throw new CancellationError('user')
        }

        const existingProject = await this.getUnlinkedProject(org.name, repoName)
        const workspace = await this.client.createDevelopmentWorkspace({
            ides: [{ name: 'VSCode' }],
            projectName: existingProject.name,
            organizationName: existingProject.org.name,
            ...settings,
        })

        await cloneToWorkspace(this.client, workspace, { name: repoName, location: repoUri })

        return workspace
    }

    private async getUnlinkedProject(organizationName: string, repoName: string): Promise<CawsProject> {
        const existingProject = await this.client.getProject({ name: repoName, organizationName }).catch(err => {
            if ((err as any).statusCode === 404) {
                return undefined
            } else {
                throw err
            }
        })

        return (
            existingProject ??
            this.client.createProject({
                name: repoName,
                organizationName,
                displayName: repoName,
                description: localize('aws.caws.createProject.description', 'Created by AWS Toolkit for Workspaces'),
            })
        )
    }
}

const Panel = VueWebview.compilePanel(CawsCreateWebview)
let activePanel: InstanceType<typeof Panel> | undefined
let subscriptions: vscode.Disposable[] | undefined

export async function showCreateWorkspace(ctx: vscode.ExtensionContext, client: ConnectedCawsClient): Promise<void> {
    activePanel ??= new Panel(ctx, client)
    const webview = await activePanel.show({
        title: localize('AWS.view.createWorkspace.title', 'Create a REMOVED.codes Workspace'),
        viewColumn: vscode.ViewColumn.Active,
    })

    if (!subscriptions) {
        subscriptions = [
            webview.onDidDispose(() => {
                vscode.Disposable.from(...(subscriptions ?? [])).dispose()
                activePanel = undefined
                subscriptions = undefined
            }),
        ]
    }
}