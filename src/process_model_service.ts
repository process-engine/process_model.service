import * as clone from 'clone';
import {Logger} from 'loggerhythm';

import {
  BpmnType,
  IModelParser,
  IProcessDefinitionRepository,
  IProcessModelService,
  Model,
  ProcessDefinitionFromRepository,
} from '@process-engine/process_model.contracts';

import {IIAMService, IIdentity} from '@essential-projects/iam_contracts';

import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '@essential-projects/errors_ts';

const logger = Logger.createLogger('processengine:persistence:process_model_service');

const superAdminClaim = 'can_manage_process_instances';
const canReadProcessModelClaim = 'can_read_process_model';
const canWriteProcessModelClaim = 'can_write_process_model';

export class ProcessModelService implements IProcessModelService {

  private readonly processDefinitionRepository: IProcessDefinitionRepository;
  private readonly iamService: IIAMService;
  private readonly bpmnModelParser: IModelParser = undefined;

  constructor(
    bpmnModelParser: IModelParser,
    iamService: IIAMService,
    processDefinitionRepository: IProcessDefinitionRepository,
  ) {
    this.processDefinitionRepository = processDefinitionRepository;
    this.iamService = iamService;
    this.bpmnModelParser = bpmnModelParser;
  }

  public async persistProcessDefinitions(
    identity: IIdentity,
    name: string,
    xml: string,
    overwriteExisting: boolean = true,
  ): Promise<void> {

    await this.ensureUserHasClaim(identity, canWriteProcessModelClaim);
    await this.validateDefinition(name, xml);

    return this.processDefinitionRepository.persistProcessDefinitions(name, xml, overwriteExisting);
  }

  public async getProcessModels(identity: IIdentity, offset: number = 0, limit: number = 0): Promise<Array<Model.Process>> {

    await this.ensureUserHasClaim(identity, canReadProcessModelClaim);

    const processModelList = await this.getProcessModelList();

    const filteredList: Array<Model.Process> = [];

    for (const processModel of processModelList) {
      const filteredProcessModel = await this.filterInaccessibleProcessModelElements(identity, processModel);

      if (filteredProcessModel) {
        filteredList.push(filteredProcessModel);
      }
    }

    const processModelSubset = this.applyPagination(filteredList, offset, limit);

    return processModelSubset;
  }

  public async getProcessModelById(identity: IIdentity, processModelId: string): Promise<Model.Process> {

    await this.ensureUserHasClaim(identity, canReadProcessModelClaim);

    const processModel = await this.retrieveProcessModel(processModelId);

    const filteredProcessModel = await this.filterInaccessibleProcessModelElements(identity, processModel);

    if (!filteredProcessModel) {
      throw new ForbiddenError('Access denied.');
    }

    return filteredProcessModel;
  }

  public async getByHash(identity: IIdentity, processModelId: string, hash: string): Promise<Model.Process> {

    await this.ensureUserHasClaim(identity, canReadProcessModelClaim);

    const definitionRaw = await this.processDefinitionRepository.getByHash(hash);

    const parsedDefinition = await this.bpmnModelParser.parseXmlToObjectModel(definitionRaw.xml);
    const processModel = parsedDefinition.processes.find((entry: Model.Process): boolean => {
      return entry.id === processModelId;
    });

    const filteredProcessModel = await this.filterInaccessibleProcessModelElements(identity, processModel);

    if (!filteredProcessModel) {
      throw new ForbiddenError('Access denied.');
    }

    return filteredProcessModel;
  }

  public async getProcessDefinitionAsXmlByName(identity: IIdentity, name: string): Promise<ProcessDefinitionFromRepository> {

    await this.ensureUserHasClaim(identity, canReadProcessModelClaim);

    const definitionRaw = await this.processDefinitionRepository.getProcessDefinitionByName(name);

    if (!definitionRaw) {
      throw new NotFoundError(`Process definition with name "${name}" not found!`);
    }

    return definitionRaw;
  }

  public async deleteProcessDefinitionById(processModelId: string): Promise<void> {
    this.processDefinitionRepository.deleteProcessDefinitionById(processModelId);
  }

  private async validateDefinition(name: string, xml: string): Promise<void> {

    let parsedProcessDefinition: Model.Definitions;

    try {
      parsedProcessDefinition = await this.bpmnModelParser.parseXmlToObjectModel(xml);
    } catch (error) {
      logger.error(`The XML for process "${name}" could not be parsed: ${error.message}`);
      const errorMessage = `The XML for process "${name}" could not be parsed.`;
      const parsingError = new UnprocessableEntityError(errorMessage);

      parsingError.additionalInformation = error;

      throw parsingError;
    }

    const processDefinitionHasMoreThanOneProcessModel = parsedProcessDefinition.processes.length > 1;
    if (processDefinitionHasMoreThanOneProcessModel) {
      const tooManyProcessModelsError = `The XML for process "${name}" contains more than one ProcessModel. This is currently not supported.`;
      logger.error(tooManyProcessModelsError);

      throw new UnprocessableEntityError(tooManyProcessModelsError);
    }

    const processsModel = parsedProcessDefinition.processes[0];

    const processModelIdIsNotEqualToDefinitionName = processsModel.id !== name;
    if (processModelIdIsNotEqualToDefinitionName) {
      const namesDoNotMatchError = `The ProcessModel contained within the diagram "${name}" must also use the name "${name}"!`;
      logger.error(namesDoNotMatchError);

      throw new UnprocessableEntityError(namesDoNotMatchError);
    }
  }

  private async retrieveProcessModel(processModelId: string): Promise<Model.Process> {

    const processModelList = await this.getProcessModelList();

    const matchingProcessModel = processModelList.find((processModel: Model.Process): boolean => {
      return processModel.id === processModelId;
    });

    if (!matchingProcessModel) {
      throw new NotFoundError(`ProcessModel with id ${processModelId} not found!`);
    }

    return matchingProcessModel;
  }

  private async getProcessModelList(): Promise<Array<Model.Process>> {

    const definitions = await this.getDefinitionList();

    const allProcessModels: Array<Model.Process> = [];

    for (const definition of definitions) {
      Array.prototype.push.apply(allProcessModels, definition.processes);
    }

    return allProcessModels;
  }

  private async getDefinitionList(): Promise<Array<Model.Definitions>> {

    const definitionsRaw = await this.processDefinitionRepository.getProcessDefinitions();

    const definitionsMapper = async (rawProcessModelData: ProcessDefinitionFromRepository): Promise<Model.Definitions> => {
      return this.bpmnModelParser.parseXmlToObjectModel(rawProcessModelData.xml);
    };

    const definitionsList = await Promise.map<ProcessDefinitionFromRepository, Model.Definitions>(definitionsRaw, definitionsMapper);

    return definitionsList;
  }

  private async filterInaccessibleProcessModelElements(
    identity: IIdentity,
    processModel: Model.Process,
  ): Promise<Model.Process> {

    const processModelCopy = clone(processModel);

    const processModelHasNoLanes = !(processModel.laneSet && processModel.laneSet.lanes && processModel.laneSet.lanes.length > 0);
    if (processModelHasNoLanes) {
      return processModelCopy;
    }

    processModelCopy.laneSet = await this.filterOutInaccessibleLanes(processModelCopy.laneSet, identity);
    processModelCopy.flowNodes = this.getFlowNodesForLaneSet(processModelCopy.laneSet, processModel.flowNodes);

    const processModelHasAccessibleStartEvent = this.checkIfProcessModelHasAccessibleStartEvents(processModelCopy);
    if (!processModelHasAccessibleStartEvent) {
      return undefined;
    }

    return processModelCopy;
  }

  private async filterOutInaccessibleLanes(laneSet: Model.ProcessElements.LaneSet, identity: IIdentity): Promise<Model.ProcessElements.LaneSet> {

    const filteredLaneSet = clone(laneSet);
    filteredLaneSet.lanes = [];

    const userIsSuperAdmin = await this.checkIfUserIsSuperAdmin(identity);

    for (const lane of laneSet.lanes) {

      const checkIfUserHasLaneClaim = async (laneName: string): Promise<boolean> => {
        try {
          await this.iamService.ensureHasClaim(identity, laneName);

          return true;
        } catch (error) {
          return false;
        }
      };

      const filteredLane = clone(lane);

      const userCanNotAccessLane = !(userIsSuperAdmin || await checkIfUserHasLaneClaim(lane.name));

      if (userCanNotAccessLane) {
        filteredLane.flowNodeReferences = [];
        delete filteredLane.childLaneSet;
      }

      const laneHasChildLanes = filteredLane.childLaneSet !== undefined;

      if (laneHasChildLanes) {
        filteredLane.childLaneSet = await this.filterOutInaccessibleLanes(filteredLane.childLaneSet, identity);
      }

      filteredLaneSet.lanes.push(filteredLane);
    }

    return filteredLaneSet;
  }

  private async ensureUserHasClaim(identity: IIdentity, claimName: string): Promise<void> {

    const userIsSuperAdmin = await this.checkIfUserIsSuperAdmin(identity);
    if (userIsSuperAdmin) {
      return;
    }

    await this.iamService.ensureHasClaim(identity, claimName);
  }

  private async checkIfUserIsSuperAdmin(identity: IIdentity): Promise<boolean> {
    try {
      await this.iamService.ensureHasClaim(identity, superAdminClaim);

      return true;
    } catch (error) {
      return false;
    }
  }

  private getFlowNodesForLaneSet(laneSet: Model.ProcessElements.LaneSet, flowNodes: Array<Model.Base.FlowNode>): Array<Model.Base.FlowNode> {

    const accessibleFlowNodes: Array<Model.Base.FlowNode> = [];

    for (const lane of laneSet.lanes) {

      // NOTE: flowNodeReferences are stored in both, the parent lane AND in the child lane!
      // So if we have a lane A with two Sublanes B and C, we must not evaluate the elements from lane A!
      // Consider a user who can only access sublane B.
      // If we were to allow him access to all references stored in lane A, he would also be granted access to the elements
      // from lane C, since they are contained within the reference set of lane A!
      const childLaneSetIsEmpty = !lane.childLaneSet || !lane.childLaneSet.lanes || lane.childLaneSet.lanes.length === 0;

      if (!childLaneSetIsEmpty) {
        const accessibleChildLaneFlowNodes = this.getFlowNodesForLaneSet(lane.childLaneSet, flowNodes);

        accessibleFlowNodes.push(...accessibleChildLaneFlowNodes);
      } else {
        for (const flowNodeId of lane.flowNodeReferences) {
          const matchingFlowNode = flowNodes.find((flowNode: Model.Base.FlowNode): boolean => {
            return flowNode.id === flowNodeId;
          });

          if (matchingFlowNode) {
            accessibleFlowNodes.push(matchingFlowNode);
          }
        }
      }
    }

    return accessibleFlowNodes;
  }

  private checkIfProcessModelHasAccessibleStartEvents(processModel: Model.Process): boolean {

    // For this check to pass, it is sufficient for the ProcessModel to have at least one accessible start event.
    const processModelHasAccessibleStartEvent = processModel.flowNodes.some((flowNode: Model.Base.FlowNode): boolean => {
      return flowNode.bpmnType === BpmnType.startEvent;
    });

    return processModelHasAccessibleStartEvent;
  }

  private applyPagination(processModels: Array<Model.Process>, offset: number, limit: number): Array<Model.Process> {

    if (offset >= processModels.length) {
      logger.error(`Using an offset of ${offset} on a ProcessModelList with ${processModels.length} entries!`);

      const error = new BadRequestError(`The offset of ${offset} is not valid!`);
      error.additionalInformation = {
        processModelListLength: processModels.length,
        offsetUsed: offset,
      } as any; //eslint-disable-line

      throw error;
    }

    let processModelSubset = offset > 0
      ? processModels.slice(offset)
      : processModels;

    const limitIsOutsideOfProcessModelList = limit < 1 || limit >= processModelSubset.length;
    if (limitIsOutsideOfProcessModelList) {
      return processModelSubset;
    }

    processModelSubset = processModelSubset.slice(0, limit);

    return processModelSubset;
  }

}
